use crate::config::Config;
use crate::model::{
    Engagement, Item, Source, SourceBatch, SourceReport, SourceState, clean_whitespace,
    parse_timestamp,
};
use crate::sources::{QueryParams, sanitize_reqwest_err};
use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;
use std::time::Instant;

#[derive(Debug, Deserialize)]
struct SessionResp {
    #[serde(rename = "accessJwt")]
    access_jwt: String,
}

#[derive(Debug, Deserialize)]
struct SearchPostsResp {
    #[serde(default)]
    posts: Vec<BskyPost>,
}

#[derive(Debug, Deserialize)]
struct BskyPost {
    uri: String,
    author: BskyAuthor,
    record: BskyRecord,
    #[serde(default)]
    embed: Option<Value>,
    #[serde(rename = "likeCount", default)]
    like_count: u64,
    #[serde(rename = "repostCount", default)]
    repost_count: u64,
    #[serde(rename = "replyCount", default)]
    reply_count: u64,
    #[serde(rename = "quoteCount", default)]
    quote_count: u64,
    #[serde(rename = "indexedAt", default)]
    indexed_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BskyAuthor {
    handle: String,
}

#[derive(Debug, Deserialize)]
struct BskyRecord {
    #[serde(default)]
    text: String,
    #[serde(rename = "createdAt", default)]
    created_at: Option<String>,
}

pub async fn collect(client: &Client, cfg: &Config, params: &QueryParams) -> SourceBatch {
    let start = Instant::now();
    let limit = params.per_source.clamp(5, 30).to_string();

    let (endpoint, bearer, method) = match (&cfg.bsky_handle, &cfg.bsky_app_password) {
        (Some(handle), Some(pass)) => match create_session(client, handle, pass).await {
            Ok(jwt) => (
                "https://bsky.social/xrpc/app.bsky.feed.searchPosts",
                Some(jwt),
                "atproto-auth",
            ),
            Err(_) => (
                "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts",
                None,
                "atproto-public(auth-fallback)",
            ),
        },
        _ => (
            "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts",
            None,
            "atproto-public",
        ),
    };

    let mut req = client.get(endpoint).query(&[
        ("q", params.query.as_str()),
        ("sort", "top"),
        ("since", params.cutoff_iso.as_str()),
        ("limit", limit.as_str()),
    ]);
    if let Some(jwt) = bearer {
        req = req.bearer_auth(jwt);
    }

    match req.send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<SearchPostsResp>().await {
            Ok(data) => {
                let items: Vec<Item> = data
                    .posts
                    .into_iter()
                    .filter_map(|p| {
                        let rkey = p.uri.rsplit('/').next()?;
                        let url = format!("https://bsky.app/profile/{}/post/{rkey}", p.author.handle);
                        let ts_str = p.record.created_at.or(p.indexed_at);
                        let ts = ts_str.as_deref().and_then(parse_timestamp);
                        let text = clean_whitespace(&p.record.text);
                        if text.is_empty() {
                            return None;
                        }
                        let link = p
                            .embed
                            .as_ref()
                            .and_then(|e| {
                                e.get("external")
                                    .and_then(|ex| ex.get("uri"))
                                    .or_else(|| e.get("media").and_then(|m| m.get("external")).and_then(|ex| ex.get("uri")))
                            })
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
                            .map(str::to_string);

                        Some(Item {
                            item_id: String::new(),
                            source: Source::Bluesky,
                            id: p.uri,
                            title: None,
                            text,
                            url,
                            link,
                            author: p.author.handle,
                            community: Some("Bluesky".to_string()),
                            published_at: ts_str,
                            published_ts: ts,
                            engagement: Engagement {
                                likes: p.like_count,
                                reposts: p.repost_count + p.quote_count,
                                comments: p.reply_count,
                                ..Default::default()
                            },
                            score: 0.0,
                            highlights: Vec::new(),
                            also_on: Vec::new(),
                        })
                    })
                    .collect();
                let fetched = items.len();
                SourceBatch {
                    report: SourceReport {
                        source: Source::Bluesky,
                        status: SourceState::Ok,
                        method: method.to_string(),
                        fetched,
                        kept: fetched,
                        elapsed_ms: start.elapsed().as_millis() as u64,
                        note: None,
                    },
                    items,
                }
            }
            Err(e) => err_batch(method, start, format!("decode error: {}", sanitize_reqwest_err(e))),
        },
        Ok(resp) => err_batch(method, start, format!("HTTP {}", resp.status())),
        Err(e) => err_batch(method, start, sanitize_reqwest_err(e)),
    }
}

async fn create_session(client: &Client, identifier: &str, password: &str) -> Result<String, String> {
    let resp = client
        .post("https://bsky.social/xrpc/com.atproto.server.createSession")
        .json(&serde_json::json!({
            "identifier": identifier,
            "password": password,
        }))
        .send()
        .await
        .map_err(sanitize_reqwest_err)?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let session: SessionResp = resp.json().await.map_err(sanitize_reqwest_err)?;
    Ok(session.access_jwt)
}

fn err_batch(method: &str, start: Instant, msg: String) -> SourceBatch {
    SourceBatch {
        report: SourceReport {
            source: Source::Bluesky,
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
