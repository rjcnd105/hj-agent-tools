use crate::config::Config;
use crate::model::{
    Engagement, Item, Source, SourceBatch, SourceReport, SourceState, clean_whitespace,
    truncate_chars, ts_to_iso,
};
use crate::sources::{QueryParams, sanitize_reqwest_err};
use reqwest::Client;
use serde::Deserialize;
use std::time::{Duration, Instant};

#[derive(Debug, Deserialize)]
struct OAuthTokenResp {
    access_token: String,
}

#[derive(Debug, Deserialize)]
struct RedditListing {
    data: RedditListingData,
}

#[derive(Debug, Deserialize)]
struct RedditListingData {
    #[serde(default)]
    children: Vec<RedditChild>,
}

#[derive(Debug, Deserialize)]
struct RedditChild {
    data: RedditPost,
}

#[derive(Debug, Deserialize)]
struct RedditPost {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    selftext: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    subreddit_name_prefixed: Option<String>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    permalink: String,
    #[serde(default)]
    score: i64,
    #[serde(default)]
    num_comments: u64,
    #[serde(default)]
    created_utc: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct CommentChild {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    data: CommentData,
}

#[derive(Debug, Default, Deserialize)]
struct CommentData {
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    score: i64,
}

#[derive(Debug, Deserialize)]
struct CommentListing {
    data: CommentListingData,
}

#[derive(Debug, Deserialize)]
struct CommentListingData {
    #[serde(default)]
    children: Vec<CommentChild>,
}

pub async fn collect(client: &Client, cfg: &Config, params: &QueryParams) -> SourceBatch {
    let start = Instant::now();
    let bucket = match params.days {
        0..=1 => "day",
        2..=7 => "week",
        8..=31 => "month",
        _ => "year",
    };
    let limit = params.per_source.clamp(5, 25).to_string();

    let oauth_token = match (&cfg.reddit_client_id, &cfg.reddit_client_secret) {
        (Some(id), Some(secret)) => fetch_oauth_token(client, id, secret, &cfg.reddit_user_agent)
            .await
            .ok(),
        _ => None,
    };

    let (base_url, method) = if oauth_token.is_some() {
        ("https://oauth.reddit.com/search", "reddit-oauth")
    } else {
        ("https://www.reddit.com/search.json", "reddit-json")
    };

    let resp = match fetch_with_retry(
        client,
        base_url,
        oauth_token.as_deref(),
        &cfg.reddit_user_agent,
        &[
            ("q", params.query.as_str()),
            ("sort", "top"),
            ("t", bucket),
            ("limit", limit.as_str()),
            ("raw_json", "1"),
        ],
    )
    .await
    {
        Ok(r) => r,
        Err(msg) => {
            return SourceBatch {
                report: SourceReport {
                    source: Source::Reddit,
                    status: SourceState::Error,
                    method: method.to_string(),
                    fetched: 0,
                    kept: 0,
                    elapsed_ms: start.elapsed().as_millis() as u64,
                    note: Some(msg),
                },
                items: Vec::new(),
            };
        }
    };

    let listing: RedditListing = match resp.json().await {
        Ok(l) => l,
        Err(e) => {
            return SourceBatch {
                report: SourceReport {
                    source: Source::Reddit,
                    status: SourceState::Error,
                    method: method.to_string(),
                    fetched: 0,
                    kept: 0,
                    elapsed_ms: start.elapsed().as_millis() as u64,
                    note: Some(format!("decode error: {}", sanitize_reqwest_err(e))),
                },
                items: Vec::new(),
            };
        }
    };

    let mut items: Vec<Item> = listing
        .data
        .children
        .into_iter()
        .filter_map(|c| {
            let p = c.data;
            let title = clean_whitespace(&p.title);
            if title.is_empty() || p.permalink.is_empty() {
                return None;
            }
            let ts = p.created_utc.map(|v| v as i64);
            let url = format!("https://www.reddit.com{}", p.permalink);
            let link = p
                .url
                .filter(|u| {
                    (u.starts_with("http://") || u.starts_with("https://"))
                        && !u.contains("reddit.com/")
                        && !u.contains("redd.it/")
                });
            Some(Item {
                item_id: String::new(),
                source: Source::Reddit,
                id: p.id,
                title: Some(title),
                text: clean_whitespace(&p.selftext),
                url,
                link,
                author: p.author.unwrap_or_else(|| "unknown".to_string()),
                community: p.subreddit_name_prefixed,
                published_at: ts.map(ts_to_iso),
                published_ts: ts,
                engagement: Engagement {
                    likes: p.score.max(0) as u64,
                    comments: p.num_comments,
                    ..Default::default()
                },
                score: 0.0,
                highlights: Vec::new(),
                also_on: Vec::new(),
            })
        })
        .collect();

    if params.fetch_comments && !items.is_empty() {
        let top_n = items.len().min(3);
        let mut handles = Vec::with_capacity(top_n);
        for item in items.iter().take(top_n) {
            let url = item.url.clone();
            let client = client.clone();
            let tok = oauth_token.clone();
            let ua = cfg.reddit_user_agent.clone();
            handles.push(tokio::spawn(async move {
                fetch_top_comments(&client, &url, tok.as_deref(), &ua).await
            }));
        }
        for (idx, h) in handles.into_iter().enumerate() {
            if let Ok(comments) = h.await {
                items[idx].highlights = comments;
            }
        }
    }

    let fetched = items.len();
    SourceBatch {
        report: SourceReport {
            source: Source::Reddit,
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

pub async fn fetch_comments_with_config(client: &Client, cfg: &Config, post_url: &str) -> Vec<String> {
    let oauth_token = match (&cfg.reddit_client_id, &cfg.reddit_client_secret) {
        (Some(id), Some(secret)) => fetch_oauth_token(client, id, secret, &cfg.reddit_user_agent)
            .await
            .ok(),
        _ => None,
    };
    fetch_top_comments(client, post_url, oauth_token.as_deref(), &cfg.reddit_user_agent).await
}

async fn fetch_oauth_token(
    client: &Client,
    client_id: &str,
    client_secret: &str,
    user_agent: &str,
) -> Result<String, String> {
    let resp = client
        .post("https://www.reddit.com/api/v1/access_token")
        .header("User-Agent", user_agent)
        .basic_auth(client_id, Some(client_secret))
        .form(&[("grant_type", "client_credentials")])
        .send()
        .await
        .map_err(sanitize_reqwest_err)?;
    if !resp.status().is_success() {
        return Err(format!("OAuth HTTP {}", resp.status()));
    }
    let tok: OAuthTokenResp = resp.json().await.map_err(sanitize_reqwest_err)?;
    Ok(tok.access_token)
}

async fn fetch_with_retry(
    client: &Client,
    url: &str,
    bearer: Option<&str>,
    user_agent: &str,
    query: &[(&str, &str)],
) -> Result<reqwest::Response, String> {
    for attempt in 0..2 {
        let mut req = client
            .get(url)
            .header("User-Agent", user_agent)
            .query(query);
        if let Some(tok) = bearer {
            req = req.bearer_auth(tok);
        }
        let resp = req.send().await.map_err(sanitize_reqwest_err)?;
        if resp.status().as_u16() == 429 && attempt == 0 {
            let wait = resp
                .headers()
                .get("retry-after")
                .and_then(|h| h.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(2)
                .min(3);
            tokio::time::sleep(Duration::from_secs(wait)).await;
            continue;
        }
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        return Ok(resp);
    }
    Err("HTTP 429 after retry".to_string())
}

pub async fn fetch_top_comments(
    client: &Client,
    post_url: &str,
    bearer: Option<&str>,
    user_agent: &str,
) -> Vec<String> {
    let comment_url = if bearer.is_some() {
        post_url.replace("https://www.reddit.com", "https://oauth.reddit.com")
    } else {
        format!("{}.json", post_url.trim_end_matches('/'))
    };
    let mut req = client
        .get(&comment_url)
        .header("User-Agent", user_agent)
        .query(&[("limit", "6"), ("sort", "top"), ("raw_json", "1")]);
    if let Some(tok) = bearer {
        req = req.bearer_auth(tok);
    }
    let Ok(resp) = req.send().await else {
        return Vec::new();
    };
    if !resp.status().is_success() {
        return Vec::new();
    }
    let Ok(listings) = resp.json::<Vec<CommentListing>>().await else {
        return Vec::new();
    };
    let Some(comments_listing) = listings.get(1) else {
        return Vec::new();
    };
    comments_listing
        .data
        .children
        .iter()
        .filter(|c| c.kind == "t1")
        .filter_map(|c| {
            let body = c.data.body.as_deref()?;
            if body == "[deleted]" || body == "[removed]" {
                return None;
            }
            let author = c.data.author.as_deref().unwrap_or("anon");
            Some(format!(
                "u/{author} ({}↑): {}",
                c.data.score.max(0),
                truncate_chars(body, 220)
            ))
        })
        .take(4)
        .collect()
}
