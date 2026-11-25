pub mod bluesky;
pub mod github;
pub mod hn;
pub mod reddit;
pub mod threads;
pub mod x;
pub mod youtube;

use crate::model::{ExternalItem, Item, Source, SourceBatch, SourceReport, SourceState};
use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::Path;
use std::time::Instant;

#[derive(Debug, Clone)]
pub struct QueryParams {
    pub query: String,
    pub days: u32,
    pub cutoff_ts: i64,
    pub cutoff_iso: String,
    pub cutoff_date: String,
    pub per_source: usize,
    pub fetch_comments: bool,
    pub include_private_github: bool,
}

/// Strip URLs (which may contain query params or tokens) from reqwest transport errors.
pub fn sanitize_reqwest_err(err: reqwest::Error) -> String {
    err.without_url().to_string()
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ExternalPayload {
    List(Vec<ExternalItem>),
    Wrapped { items: Vec<ExternalItem> },
}

pub async fn load_json_file(source: Source, path: &Path) -> SourceBatch {
    let start = Instant::now();
    match read_external_items(source, path).await {
        Ok(items) => {
            let fetched = items.len();
            SourceBatch {
                report: SourceReport {
                    source,
                    status: SourceState::Ok,
                    method: format!("json-file:{}", path.display()),
                    fetched,
                    kept: fetched,
                    elapsed_ms: start.elapsed().as_millis() as u64,
                    note: None,
                },
                items,
            }
        }
        Err(err) => SourceBatch {
            report: SourceReport {
                source,
                status: SourceState::Error,
                method: "json-file".to_string(),
                fetched: 0,
                kept: 0,
                elapsed_ms: start.elapsed().as_millis() as u64,
                note: Some(err.to_string()),
            },
            items: Vec::new(),
        },
    }
}

async fn read_external_items(source: Source, path: &Path) -> Result<Vec<Item>> {
    let raw = tokio::fs::read_to_string(path)
        .await
        .with_context(|| format!("failed to read {}", path.display()))?;
    let payload: ExternalPayload = serde_json::from_str(&raw)
        .with_context(|| format!("invalid JSON in {}", path.display()))?;
    let raw_items = match payload {
        ExternalPayload::List(v) => v,
        ExternalPayload::Wrapped { items } => items,
    };
    Ok(raw_items
        .into_iter()
        .filter_map(|e| e.into_item(source))
        .collect())
}
