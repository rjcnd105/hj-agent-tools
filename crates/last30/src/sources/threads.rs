use crate::config::Config;
use crate::model::{
    Engagement, Item, Source, SourceBatch, SourceReport, SourceState, clean_whitespace,
    parse_timestamp,
};
use crate::sources::{QueryParams, sanitize_reqwest_err};
use reqwest::Client;
use serde::Deserialize;
use std::time::Instant;

#[derive(Debug, Deserialize)]
struct ThreadsSearchResp {
    #[serde(default)]
    data: Vec<ThreadsPost>,
}

#[derive(Debug, Deserialize)]
struct ThreadsPost {
    id: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    permalink: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
}

pub fn has_api_credentials(cfg: &Config) -> bool {
    cfg.threads_access_token.is_some()
}

pub async fn collect_via_api(client: &Client, cfg: &Config, params: &QueryParams) -> SourceBatch {
    let start = Instant::now();
    let Some(token) = &cfg.threads_access_token else {
        return SourceBatch {
            report: SourceReport {
                source: Source::Threads,
                status: SourceState::Skipped,
                method: "none".to_string(),
                fetched: 0,
                kept: 0,
                elapsed_ms: 0,
                note: Some("no THREADS_ACCESS_TOKEN and browser disabled".to_string()),
            },
            items: Vec::new(),
        };
    };

    let endpoint = match &cfg.threads_user_id {
        Some(uid) => format!("https://graph.threads.net/v1.0/{uid}/keyword_search"),
        None => "https://graph.threads.net/v1.0/keyword_search".to_string(),
    };
    let since = params.cutoff_ts.to_string();
    let limit = params.per_source.clamp(5, 25).to_string();

    let resp = client
        .get(&endpoint)
        .bearer_auth(token)
        .query(&[
            ("q", params.query.as_str()),
            ("search_type", "TOP"),
            ("since", since.as_str()),
            ("limit", limit.as_str()),
            ("fields", "id,text,username,permalink,timestamp"),
        ])
        .send()
        .await;

    let data: ThreadsSearchResp = match resp {
        Ok(r) if r.status().is_success() => match r.json().await {
            Ok(d) => d,
            Err(e) => return err_batch(start, format!("decode error: {}", sanitize_reqwest_err(e))),
        },
        Ok(r) => return err_batch(start, format!("HTTP {}", r.status())),
        Err(e) => return err_batch(start, sanitize_reqwest_err(e)),
    };

    let items: Vec<Item> = data
        .data
        .into_iter()
        .filter_map(|p| {
            let text = clean_whitespace(p.text.as_deref().unwrap_or_default());
            if text.is_empty() {
                return None;
            }
            let url = p.permalink?;
            let ts = p.timestamp.as_deref().and_then(parse_timestamp);
            Some(Item {
                item_id: String::new(),
                source: Source::Threads,
                id: p.id,
                title: None,
                text,
                url,
                link: None,
                author: p.username.unwrap_or_else(|| "unknown".to_string()),
                community: Some("Threads".to_string()),
                published_at: p.timestamp,
                published_ts: ts,
                engagement: Engagement::default(),
                score: 0.0,
                highlights: Vec::new(),
                also_on: Vec::new(),
            })
        })
        .collect();

    let fetched = items.len();
    SourceBatch {
        report: SourceReport {
            source: Source::Threads,
            status: SourceState::Ok,
            method: "threads-api".to_string(),
            fetched,
            kept: fetched,
            elapsed_ms: start.elapsed().as_millis() as u64,
            note: None,
        },
        items,
    }
}

fn err_batch(start: Instant, msg: String) -> SourceBatch {
    SourceBatch {
        report: SourceReport {
            source: Source::Threads,
            status: SourceState::Error,
            method: "threads-api".to_string(),
            fetched: 0,
            kept: 0,
            elapsed_ms: start.elapsed().as_millis() as u64,
            note: Some(msg),
        },
        items: Vec::new(),
    }
}
