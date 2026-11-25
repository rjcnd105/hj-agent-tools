use crate::model::{
    Engagement, Item, Source, SourceBatch, SourceReport, SourceState, clean_whitespace,
    truncate_chars, ts_to_iso,
};
use crate::sources::{QueryParams, sanitize_reqwest_err};
use reqwest::Client;
use serde::Deserialize;
use std::collections::HashSet;
use std::time::Instant;

#[derive(Debug, Deserialize)]
struct AlgoliaResponse {
    #[serde(default)]
    hits: Vec<AlgoliaHit>,
}

#[derive(Debug, Deserialize)]
struct AlgoliaHit {
    #[serde(rename = "objectID")]
    object_id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    story_text: Option<String>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    points: Option<u64>,
    #[serde(default)]
    num_comments: Option<u64>,
    #[serde(default)]
    created_at_i: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct AlgoliaItemDetail {
    #[serde(default)]
    children: Vec<AlgoliaComment>,
}

#[derive(Debug, Deserialize)]
struct AlgoliaComment {
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    points: Option<u64>,
}

pub async fn collect(client: &Client, params: &QueryParams) -> SourceBatch {
    let start = Instant::now();
    let numeric_filter = format!("created_at_i>{}", params.cutoff_ts);
    let hits_per_page = params.per_source.clamp(5, 30).to_string();
    let recent_hits = (params.per_source / 2).max(5).to_string();

    let rel_req = client
        .get("https://hn.algolia.com/api/v1/search")
        .query(&[
            ("query", params.query.as_str()),
            ("tags", "story"),
            ("numericFilters", numeric_filter.as_str()),
            ("hitsPerPage", hits_per_page.as_str()),
        ])
        .send();

    let recent_req = client
        .get("https://hn.algolia.com/api/v1/search_by_date")
        .query(&[
            ("query", params.query.as_str()),
            ("tags", "story"),
            ("numericFilters", numeric_filter.as_str()),
            ("hitsPerPage", recent_hits.as_str()),
        ])
        .send();

    let (rel_res, recent_res) = tokio::join!(rel_req, recent_req);

    let mut all_hits = Vec::new();
    let mut first_err: Option<String> = None;

    for res in [rel_res, recent_res] {
        match res {
            Ok(resp) if resp.status().is_success() => match resp.json::<AlgoliaResponse>().await {
                Ok(parsed) => all_hits.extend(parsed.hits),
                Err(e) => {
                    if first_err.is_none() {
                        first_err = Some(format!("decode error: {}", sanitize_reqwest_err(e)));
                    }
                }
            },
            Ok(resp) => {
                if first_err.is_none() {
                    first_err = Some(format!("HTTP {}", resp.status()));
                }
            }
            Err(e) => {
                if first_err.is_none() {
                    first_err = Some(sanitize_reqwest_err(e));
                }
            }
        }
    }

    let mut seen = HashSet::new();
    let mut items = Vec::new();

    for hit in all_hits {
        if !seen.insert(hit.object_id.clone()) {
            continue;
        }
        let Some(title_str) = hit
            .title
            .as_deref()
            .map(clean_whitespace)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };

        let hn_url = format!("https://news.ycombinator.com/item?id={}", hit.object_id);
        let link = hit
            .url
            .map(|u| u.trim().to_string())
            .filter(|u| u.starts_with("http://") || u.starts_with("https://"));

        let text = hit
            .story_text
            .as_deref()
            .map(strip_html_basic)
            .map(|s| clean_whitespace(&s))
            .unwrap_or_default();

        items.push(Item {
            item_id: String::new(),
            source: Source::Hn,
            id: hit.object_id,
            title: Some(title_str),
            text,
            url: hn_url,
            link,
            author: hit.author.unwrap_or_else(|| "unknown".to_string()),
            community: Some("Hacker News".to_string()),
            published_at: hit.created_at_i.map(ts_to_iso),
            published_ts: hit.created_at_i,
            engagement: Engagement {
                likes: hit.points.unwrap_or(0),
                comments: hit.num_comments.unwrap_or(0),
                ..Default::default()
            },
            score: 0.0,
            highlights: Vec::new(),
            also_on: Vec::new(),
        });
    }

    let fetched = items.len();
    let (status, note) = if fetched > 0 || first_err.is_none() {
        (SourceState::Ok, None)
    } else {
        (SourceState::Error, first_err)
    };

    SourceBatch {
        report: SourceReport {
            source: Source::Hn,
            status,
            method: "algolia-api".to_string(),
            fetched,
            kept: fetched,
            elapsed_ms: start.elapsed().as_millis() as u64,
            note,
        },
        items,
    }
}

pub async fn fetch_top_comments(client: &Client, story_id: &str) -> Vec<String> {
    if !story_id.bytes().all(|b| b.is_ascii_digit()) {
        return Vec::new();
    }
    let url = format!("https://hn.algolia.com/api/v1/items/{story_id}");
    let Ok(resp) = client.get(&url).send().await else {
        return Vec::new();
    };
    if !resp.status().is_success() {
        return Vec::new();
    }
    let Ok(detail) = resp.json::<AlgoliaItemDetail>().await else {
        return Vec::new();
    };
    detail
        .children
        .into_iter()
        .filter_map(|c| {
            let text = c.text.as_deref().map(strip_html_basic)?;
            let cleaned = clean_whitespace(&text);
            if cleaned.is_empty() {
                return None;
            }
            let author = c.author.unwrap_or_else(|| "anon".to_string());
            let pts = c.points.map(|p| format!(" ({p}↑)")).unwrap_or_default();
            Some(format!("@{author}{pts}: {}", truncate_chars(&cleaned, 240)))
        })
        .take(5)
        .collect()
}

fn strip_html_basic(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.replace("&#x27;", "'")
        .replace("&#x2F;", "/")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}
