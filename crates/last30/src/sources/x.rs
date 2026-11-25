use crate::config::Config;
use crate::model::{
    Engagement, ExternalItem, Item, Source, SourceBatch, SourceReport, SourceState,
    clean_whitespace, parse_timestamp,
};
use crate::sources::{QueryParams, sanitize_reqwest_err};
use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::time::Instant;

#[derive(Debug, Deserialize)]
struct XRecentResp {
    #[serde(default)]
    data: Vec<XTweet>,
    #[serde(default)]
    includes: Option<XIncludes>,
}

#[derive(Debug, Deserialize)]
struct XIncludes {
    #[serde(default)]
    users: Vec<XUser>,
}

#[derive(Debug, Deserialize)]
struct XUser {
    id: String,
    username: String,
}

#[derive(Debug, Deserialize)]
struct XTweet {
    id: String,
    text: String,
    #[serde(default)]
    author_id: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    public_metrics: Option<XMetrics>,
    #[serde(default)]
    entities: Option<XEntities>,
}

#[derive(Debug, Deserialize)]
struct XEntities {
    #[serde(default)]
    urls: Vec<XUrlEntity>,
}

#[derive(Debug, Deserialize)]
struct XUrlEntity {
    #[serde(default)]
    expanded_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct XMetrics {
    #[serde(default)]
    like_count: u64,
    #[serde(default)]
    retweet_count: u64,
    #[serde(default)]
    reply_count: u64,
    #[serde(default)]
    quote_count: u64,
    #[serde(default)]
    impression_count: u64,
}

pub fn has_api_credentials(cfg: &Config) -> bool {
    cfg.x_bearer_token.is_some() || cfg.xai_api_key.is_some()
}

pub async fn collect_via_api(client: &Client, cfg: &Config, params: &QueryParams) -> SourceBatch {
    let start = Instant::now();
    if let Some(bearer) = &cfg.x_bearer_token {
        return collect_v2(client, bearer, params, start).await;
    }
    if let Some(xai_key) = &cfg.xai_api_key {
        return collect_xai(client, xai_key, params, start).await;
    }
    SourceBatch {
        report: SourceReport {
            source: Source::X,
            status: SourceState::Skipped,
            method: "none".to_string(),
            fetched: 0,
            kept: 0,
            elapsed_ms: 0,
            note: Some("no X_BEARER_TOKEN / XAI_API_KEY and browser disabled".to_string()),
        },
        items: Vec::new(),
    }
}

async fn collect_v2(
    client: &Client,
    bearer: &str,
    params: &QueryParams,
    start: Instant,
) -> SourceBatch {
    let max_results = params.per_source.clamp(10, 50).to_string();
    let query = format!("{} -is:retweet", params.query);
    let resp = client
        .get("https://api.x.com/2/tweets/search/recent")
        .bearer_auth(bearer)
        .query(&[
            ("query", query.as_str()),
            ("max_results", max_results.as_str()),
            ("tweet.fields", "created_at,public_metrics,author_id,entities"),
            ("expansions", "author_id"),
            ("user.fields", "username"),
        ])
        .send()
        .await;

    let data: XRecentResp = match resp {
        Ok(r) if r.status().is_success() => match r.json().await {
            Ok(d) => d,
            Err(e) => {
                return err_batch(
                    "x-api-v2",
                    start,
                    format!("decode error: {}", sanitize_reqwest_err(e)),
                );
            }
        },
        Ok(r) => return err_batch("x-api-v2", start, format!("HTTP {}", r.status())),
        Err(e) => return err_batch("x-api-v2", start, sanitize_reqwest_err(e)),
    };

    let users: HashMap<String, String> = data
        .includes
        .map(|inc| inc.users.into_iter().map(|u| (u.id, u.username)).collect())
        .unwrap_or_default();

    let items: Vec<Item> = data
        .data
        .into_iter()
        .map(|t| {
            let author = t
                .author_id
                .as_deref()
                .and_then(|id| users.get(id))
                .cloned()
                .unwrap_or_else(|| "i".to_string());
            let url = format!("https://x.com/{author}/status/{}", t.id);
            let ts = t.created_at.as_deref().and_then(parse_timestamp);
            let link = t.entities.and_then(|ent| {
                ent.urls.into_iter().find_map(|u| {
                    let s = u.expanded_url?;
                    is_external_non_x_url(&s).then_some(s)
                })
            });
            let m = t.public_metrics;
            Item {
                item_id: String::new(),
                source: Source::X,
                id: t.id,
                title: None,
                text: clean_whitespace(&t.text),
                url,
                link,
                author,
                community: Some("X".to_string()),
                published_at: t.created_at,
                published_ts: ts,
                engagement: Engagement {
                    likes: m.as_ref().map(|x| x.like_count).unwrap_or(0),
                    reposts: m
                        .as_ref()
                        .map(|x| x.retweet_count + x.quote_count)
                        .unwrap_or(0),
                    comments: m.as_ref().map(|x| x.reply_count).unwrap_or(0),
                    views: m.as_ref().map(|x| x.impression_count).unwrap_or(0),
                    stars: 0,
                },
                score: 0.0,
                highlights: Vec::new(),
                also_on: Vec::new(),
            }
        })
        .collect();

    let fetched = items.len();
    SourceBatch {
        report: SourceReport {
            source: Source::X,
            status: SourceState::Ok,
            method: "x-api-v2".to_string(),
            fetched,
            kept: fetched,
            elapsed_ms: start.elapsed().as_millis() as u64,
            note: if params.days > 7 {
                Some("X v2 recent search caps window at 7d".to_string())
            } else {
                None
            },
        },
        items,
    }
}

async fn collect_xai(
    client: &Client,
    xai_key: &str,
    params: &QueryParams,
    start: Instant,
) -> SourceBatch {
    let prompt = format!(
        "Search X posts about \"{}\" since {}. Return ONLY a JSON array of up to {} objects with keys: url, author, text, published_at (ISO8601), likes (int), reposts (int), comments (int), views (int). No markdown fences.",
        params.query,
        params.cutoff_date,
        params.per_source.clamp(5, 20)
    );

    let body = serde_json::json!({
        "model": "grok-4-1-fast",
        "tools": [{ "type": "x_search", "from_date": params.cutoff_date }],
        "input": prompt,
    });

    let resp = client
        .post("https://api.x.ai/v1/responses")
        .bearer_auth(xai_key)
        .json(&body)
        .send()
        .await;

    let val: Value = match resp {
        Ok(r) if r.status().is_success() => match r.json().await {
            Ok(v) => v,
            Err(e) => {
                return err_batch(
                    "xai-x-search",
                    start,
                    format!("decode error: {}", sanitize_reqwest_err(e)),
                );
            }
        },
        Ok(r) => return err_batch("xai-x-search", start, format!("HTTP {}", r.status())),
        Err(e) => return err_batch("xai-x-search", start, sanitize_reqwest_err(e)),
    };

    let text = extract_xai_output_text(&val);
    let Some(json_slice) = extract_json_array(&text) else {
        return err_batch(
            "xai-x-search",
            start,
            "xAI response did not contain a JSON array".to_string(),
        );
    };
    let raw_items: Vec<ExternalItem> = match serde_json::from_str(json_slice) {
        Ok(v) => v,
        Err(e) => {
            return err_batch(
                "xai-x-search",
                start,
                format!("xAI JSON array parse error: {e}"),
            );
        }
    };
    let items: Vec<Item> = raw_items
        .into_iter()
        .filter_map(|e| e.into_item(Source::X))
        .collect();
    let fetched = items.len();

    SourceBatch {
        report: SourceReport {
            source: Source::X,
            status: SourceState::Ok,
            method: "xai-x-search".to_string(),
            fetched,
            kept: fetched,
            elapsed_ms: start.elapsed().as_millis() as u64,
            note: None,
        },
        items,
    }
}

fn extract_xai_output_text(val: &Value) -> String {
    if let Some(s) = val.get("output_text").and_then(Value::as_str) {
        return s.to_string();
    }
    let mut out = String::new();
    if let Some(arr) = val.get("output").and_then(Value::as_array) {
        for entry in arr {
            if let Some(content) = entry.get("content").and_then(Value::as_array) {
                for c in content {
                    if let Some(t) = c.get("text").and_then(Value::as_str) {
                        out.push_str(t);
                    }
                }
            }
        }
    }
    out
}

fn extract_json_array(s: &str) -> Option<&str> {
    let start = s.find('[')?;
    let end = s.rfind(']')?;
    (end >= start).then(|| &s[start..=end])
}

fn is_external_non_x_url(raw: &str) -> bool {
    let Ok(u) = url::Url::parse(raw) else {
        return false;
    };
    if !matches!(u.scheme(), "http" | "https") {
        return false;
    }
    let Some(h) = u.host_str().map(|s| s.to_ascii_lowercase()) else {
        return false;
    };
    h != "x.com"
        && !h.ends_with(".x.com")
        && h != "twitter.com"
        && !h.ends_with(".twitter.com")
        && h != "t.co"
}

fn err_batch(method: &str, start: Instant, msg: String) -> SourceBatch {
    SourceBatch {
        report: SourceReport {
            source: Source::X,
            status: SourceState::Error,
            method: method.to_string(),
            fetched: 0,
            kept: 0,
            elapsed_ms: start.elapsed().as_millis() as u64,
            note: Some(msg),
        },
        items: Vec::new(),
    }
}
