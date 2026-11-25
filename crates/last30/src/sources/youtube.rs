use crate::config::Config;
use crate::model::{
    Engagement, Item, Source, SourceBatch, SourceReport, SourceState, clean_whitespace,
    parse_timestamp, ts_to_iso,
};
use crate::sources::{QueryParams, sanitize_reqwest_err};
use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::time::Instant;

#[derive(Debug, Deserialize)]
struct YtSearchResp {
    #[serde(default)]
    items: Vec<YtSearchItem>,
}

#[derive(Debug, Deserialize)]
struct YtSearchItem {
    id: YtVideoId,
    snippet: YtSnippet,
}

#[derive(Debug, Deserialize)]
struct YtVideoId {
    #[serde(rename = "videoId", default)]
    video_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct YtSnippet {
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(rename = "channelTitle", default)]
    channel_title: String,
    #[serde(rename = "publishedAt", default)]
    published_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct YtVideosResp {
    #[serde(default)]
    items: Vec<YtVideoStatsItem>,
}

#[derive(Debug, Deserialize)]
struct YtVideoStatsItem {
    id: String,
    #[serde(default)]
    statistics: Option<YtStats>,
}

#[derive(Debug, Deserialize)]
struct YtStats {
    #[serde(rename = "viewCount", default)]
    view_count: Option<String>,
    #[serde(rename = "likeCount", default)]
    like_count: Option<String>,
    #[serde(rename = "commentCount", default)]
    comment_count: Option<String>,
}

pub async fn collect(client: &Client, cfg: &Config, params: &QueryParams) -> SourceBatch {
    let start = Instant::now();
    if let Some(api_key) = &cfg.youtube_api_key {
        return collect_via_api(client, api_key, params, start).await;
    }
    collect_via_web(client, params, start).await
}

async fn collect_via_api(
    client: &Client,
    api_key: &str,
    params: &QueryParams,
    start: Instant,
) -> SourceBatch {
    let max_results = params.per_source.clamp(5, 25).to_string();
    let search_res = client
        .get("https://www.googleapis.com/youtube/v3/search")
        .header("X-Goog-Api-Key", api_key)
        .query(&[
            ("part", "snippet"),
            ("type", "video"),
            ("order", "relevance"),
            ("publishedAfter", params.cutoff_iso.as_str()),
            ("maxResults", max_results.as_str()),
            ("q", params.query.as_str()),
        ])
        .send()
        .await;

    let search_data: YtSearchResp = match search_res {
        Ok(resp) if resp.status().is_success() => match resp.json().await {
            Ok(d) => d,
            Err(e) => {
                return err_batch(
                    "youtube-api",
                    start,
                    format!("decode error: {}", sanitize_reqwest_err(e)),
                );
            }
        },
        Ok(resp) => return err_batch("youtube-api", start, format!("HTTP {}", resp.status())),
        Err(e) => return err_batch("youtube-api", start, sanitize_reqwest_err(e)),
    };

    let ids: Vec<String> = search_data
        .items
        .iter()
        .filter_map(|i| i.id.video_id.clone())
        .collect();

    let mut stats_map: HashMap<String, Engagement> = HashMap::new();
    if !ids.is_empty() {
        let joined = ids.join(",");
        if let Ok(resp) = client
            .get("https://www.googleapis.com/youtube/v3/videos")
            .header("X-Goog-Api-Key", api_key)
            .query(&[("part", "statistics"), ("id", joined.as_str())])
            .send()
            .await
            && resp.status().is_success()
            && let Ok(vresp) = resp.json::<YtVideosResp>().await
        {
            for v in vresp.items {
                if let Some(st) = v.statistics {
                    stats_map.insert(
                        v.id,
                        Engagement {
                            views: st.view_count.and_then(|s| s.parse().ok()).unwrap_or(0),
                            likes: st.like_count.and_then(|s| s.parse().ok()).unwrap_or(0),
                            comments: st.comment_count.and_then(|s| s.parse().ok()).unwrap_or(0),
                            ..Default::default()
                        },
                    );
                }
            }
        }
    }

    let items: Vec<Item> = search_data
        .items
        .into_iter()
        .filter_map(|it| {
            let vid = it.id.video_id?;
            let ts = it.snippet.published_at.as_deref().and_then(parse_timestamp);
            let engagement = stats_map.remove(&vid).unwrap_or_default();
            Some(Item {
                item_id: String::new(),
                source: Source::Youtube,
                id: vid.clone(),
                title: Some(clean_whitespace(&it.snippet.title)),
                text: clean_whitespace(&it.snippet.description),
                url: format!("https://www.youtube.com/watch?v={vid}"),
                link: None,
                author: it.snippet.channel_title.clone(),
                community: Some(it.snippet.channel_title),
                published_at: it.snippet.published_at,
                published_ts: ts,
                engagement,
                score: 0.0,
                highlights: Vec::new(),
                also_on: Vec::new(),
            })
        })
        .collect();

    let fetched = items.len();
    SourceBatch {
        report: SourceReport {
            source: Source::Youtube,
            status: SourceState::Ok,
            method: "youtube-api".to_string(),
            fetched,
            kept: fetched,
            elapsed_ms: start.elapsed().as_millis() as u64,
            note: None,
        },
        items,
    }
}

/// Zero-config YouTube web search using `ytInitialData` JSON embedded in search HTML.
async fn collect_via_web(client: &Client, params: &QueryParams, start: Instant) -> SourceBatch {
    let sp = match params.days {
        0..=1 => "EgIIAg%3D%3D",
        2..=7 => "EgIIAw%3D%3D",
        8..=35 => "EgIIBA%3D%3D",
        _ => "EgIIBQ%3D%3D",
    };

    let url = format!(
        "https://www.youtube.com/results?search_query={}&sp={sp}&hl=en&gl=US",
        urlencoding_minimal(&params.query)
    );

    let resp = match client
        .get(&url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        )
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => return err_batch("youtube-web", start, format!("HTTP {}", r.status())),
        Err(e) => return err_batch("youtube-web", start, sanitize_reqwest_err(e)),
    };

    let html = match resp.text().await {
        Ok(t) => t,
        Err(e) => {
            return err_batch(
                "youtube-web",
                start,
                format!("read error: {}", sanitize_reqwest_err(e)),
            );
        }
    };

    let Some(json_str) = extract_yt_initial_data(&html) else {
        return err_batch("youtube-web", start, "ytInitialData not found".to_string());
    };

    let root: Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(e) => return err_batch("youtube-web", start, format!("JSON parse error: {e}")),
    };

    let now_ts = jiff::Timestamp::now().as_second();
    let mut items = Vec::new();
    collect_video_renderers(&root, now_ts, params.per_source.clamp(5, 25), &mut items);

    let fetched = items.len();
    SourceBatch {
        report: SourceReport {
            source: Source::Youtube,
            status: SourceState::Ok,
            method: "youtube-web".to_string(),
            fetched,
            kept: fetched,
            elapsed_ms: start.elapsed().as_millis() as u64,
            note: None,
        },
        items,
    }
}

fn extract_yt_initial_data(html: &str) -> Option<&str> {
    let markers = [
        "var ytInitialData = ",
        "window[\"ytInitialData\"] = ",
        "ytInitialData = ",
    ];
    for marker in markers {
        if let Some(pos) = html.find(marker) {
            let rest = &html[pos + marker.len()..];
            if let Some(end) = find_json_object_end(rest) {
                return Some(&rest[..=end]);
            }
        }
    }
    None
}

fn find_json_object_end(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    if bytes.first() != Some(&b'{') {
        return None;
    }
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escaped = false;
    for (idx, &b) in bytes.iter().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(idx);
                }
            }
            _ => {}
        }
    }
    None
}

fn collect_video_renderers(val: &Value, now_ts: i64, limit: usize, out: &mut Vec<Item>) {
    if out.len() >= limit {
        return;
    }
    match val {
        Value::Object(map) => {
            if let Some(vr) = map.get("videoRenderer")
                && let Some(item) = parse_video_renderer(vr, now_ts)
            {
                out.push(item);
                if out.len() >= limit {
                    return;
                }
            }
            for v in map.values() {
                collect_video_renderers(v, now_ts, limit, out);
                if out.len() >= limit {
                    return;
                }
            }
        }
        Value::Array(arr) => {
            for v in arr {
                collect_video_renderers(v, now_ts, limit, out);
                if out.len() >= limit {
                    return;
                }
            }
        }
        _ => {}
    }
}

fn parse_video_renderer(vr: &Value, now_ts: i64) -> Option<Item> {
    let vid = vr.get("videoId")?.as_str()?.to_string();
    let title = extract_runs_text(vr.get("title")?)?;
    let channel = vr
        .get("ownerText")
        .or_else(|| vr.get("longBylineText"))
        .and_then(extract_runs_text)
        .unwrap_or_else(|| "unknown".to_string());

    let published_raw = vr
        .get("publishedTimeText")
        .and_then(extract_runs_text)
        .unwrap_or_default();
    let published_ts = parse_relative_time(&published_raw, now_ts);

    let views_raw = vr
        .get("viewCountText")
        .and_then(extract_runs_text)
        .unwrap_or_default();
    let views = parse_human_count(&views_raw);

    let snippet = vr
        .get("detailedMetadataSnippets")
        .and_then(|s| s.get(0))
        .and_then(|s| s.get("snippetText"))
        .and_then(extract_runs_text)
        .unwrap_or_default();

    Some(Item {
        item_id: String::new(),
        source: Source::Youtube,
        id: vid.clone(),
        title: Some(clean_whitespace(&title)),
        text: clean_whitespace(&snippet),
        url: format!("https://www.youtube.com/watch?v={vid}"),
        link: None,
        author: channel.clone(),
        community: Some(channel),
        published_at: published_ts.map(ts_to_iso),
        published_ts,
        engagement: Engagement {
            views,
            ..Default::default()
        },
        score: 0.0,
        highlights: Vec::new(),
        also_on: Vec::new(),
    })
}

fn extract_runs_text(val: &Value) -> Option<String> {
    if let Some(s) = val.get("simpleText").and_then(Value::as_str) {
        return Some(s.to_string());
    }
    if let Some(runs) = val.get("runs").and_then(Value::as_array) {
        let mut s = String::new();
        for r in runs {
            if let Some(t) = r.get("text").and_then(Value::as_str) {
                s.push_str(t);
            }
        }
        if !s.is_empty() {
            return Some(s);
        }
    }
    None
}

pub fn parse_relative_time(raw: &str, now_ts: i64) -> Option<i64> {
    let lower = raw.to_ascii_lowercase();
    let cleaned = lower
        .trim()
        .trim_start_matches("streamed ")
        .trim_start_matches("premiered ");
    let mut parts = cleaned.split_whitespace();
    let first = parts.next()?;

    let (num, unit) = if let Ok(n) = first.parse::<i64>() {
        (n, parts.next()?)
    } else {
        let split_at = first.find(|c: char| !c.is_ascii_digit())?;
        if split_at == 0 {
            return None;
        }
        let n: i64 = first[..split_at].parse().ok()?;
        (n, &first[split_at..])
    };

    let secs = if unit == "s" || unit.starts_with("sec") {
        num
    } else if unit == "m" || unit.starts_with("min") {
        num * 60
    } else if unit == "h" || unit.starts_with("hour") || unit == "hr" || unit == "hrs" {
        num * 3600
    } else if unit == "d" || unit.starts_with("day") {
        num * 86_400
    } else if unit == "w" || unit.starts_with("week") || unit == "wk" || unit == "wks" {
        num * 7 * 86_400
    } else if unit == "mo" || unit == "mos" || unit.starts_with("month") {
        num * 30 * 86_400
    } else if unit == "y" || unit == "yr" || unit == "yrs" || unit.starts_with("year") {
        num * 365 * 86_400
    } else {
        return None;
    };
    Some(now_ts - secs)
}

pub fn parse_human_count(raw: &str) -> u64 {
    let token = raw.split_whitespace().next().unwrap_or("");
    let cleaned = token.replace(',', "");
    let lower = cleaned.to_ascii_lowercase();
    if let Some(n) = lower.strip_suffix('k') {
        return (n.parse::<f64>().unwrap_or(0.0) * 1_000.0) as u64;
    }
    if let Some(n) = lower.strip_suffix('m') {
        return (n.parse::<f64>().unwrap_or(0.0) * 1_000_000.0) as u64;
    }
    if let Some(n) = lower.strip_suffix('b') {
        return (n.parse::<f64>().unwrap_or(0.0) * 1_000_000_000.0) as u64;
    }
    cleaned.parse::<u64>().unwrap_or(0)
}

fn urlencoding_minimal(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 2);
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn err_batch(method: &str, start: Instant, msg: String) -> SourceBatch {
    SourceBatch {
        report: SourceReport {
            source: Source::Youtube,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_relative_dates_and_counts() {
        let now = 1_800_000_000;
        assert_eq!(parse_relative_time("3 days ago", now), Some(now - 3 * 86_400));
        assert_eq!(parse_relative_time("13d ago", now), Some(now - 13 * 86_400));
        assert_eq!(parse_relative_time("3w ago", now), Some(now - 21 * 86_400));
        assert_eq!(parse_relative_time("2mo ago", now), Some(now - 60 * 86_400));
        assert_eq!(
            parse_relative_time("Streamed 2 weeks ago", now),
            Some(now - 14 * 86_400)
        );
        assert_eq!(parse_human_count("123,456 views"), 123_456);
        assert_eq!(parse_human_count("1.5K views"), 1_500);
        assert_eq!(parse_human_count("2.3M views"), 2_300_000);
    }
}
