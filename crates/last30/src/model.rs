use clap::ValueEnum;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;
use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Hn,
    Github,
    Bluesky,
    Reddit,
    Youtube,
    X,
    Threads,
}

impl Source {
    pub const ALL: [Source; 7] = [
        Source::Hn,
        Source::Github,
        Source::Bluesky,
        Source::Reddit,
        Source::Youtube,
        Source::X,
        Source::Threads,
    ];

    pub const FAST_HTTP: [Source; 5] = [
        Source::Hn,
        Source::Github,
        Source::Bluesky,
        Source::Reddit,
        Source::Youtube,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Source::Hn => "hn",
            Source::Github => "github",
            Source::Bluesky => "bluesky",
            Source::Reddit => "reddit",
            Source::Youtube => "youtube",
            Source::X => "x",
            Source::Threads => "threads",
        }
    }

    pub fn has_titles(self) -> bool {
        matches!(self, Source::Hn | Source::Github | Source::Reddit | Source::Youtube)
    }
}

impl fmt::Display for Source {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Source {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "hn" | "hackernews" | "hacker-news" => Ok(Source::Hn),
            "github" | "gh" => Ok(Source::Github),
            "bluesky" | "bsky" => Ok(Source::Bluesky),
            "reddit" => Ok(Source::Reddit),
            "youtube" | "yt" => Ok(Source::Youtube),
            "x" | "twitter" => Ok(Source::X),
            "threads" | "thread" => Ok(Source::Threads),
            other => Err(format!("unknown source: {other}")),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Engagement {
    #[serde(default)]
    pub likes: u64,
    #[serde(default)]
    pub comments: u64,
    #[serde(default)]
    pub reposts: u64,
    #[serde(default)]
    pub views: u64,
    #[serde(default)]
    pub stars: u64,
}

impl Engagement {
    pub fn is_zero(&self) -> bool {
        self.likes == 0
            && self.comments == 0
            && self.reposts == 0
            && self.views == 0
            && self.stars == 0
    }

    pub fn weighted(&self, source: Source) -> f64 {
        match source {
            Source::Hn => self.likes as f64 + self.comments as f64 * 1.5,
            Source::Github => {
                // Damp cumulative stars strongly so active 30-day issues/PRs aren't drowned out
                (1.0 + self.stars as f64).ln() * 2.5
                    + self.likes as f64 * 4.0
                    + self.comments as f64 * 2.5
            }
            Source::Bluesky => {
                self.likes as f64 + self.reposts as f64 * 2.5 + self.comments as f64 * 2.0
            }
            Source::Reddit => self.likes as f64 + self.comments as f64 * 1.8,
            Source::Youtube => {
                (self.views as f64).sqrt() * 0.5
                    + self.likes as f64 * 0.8
                    + self.comments as f64 * 2.0
            }
            Source::X => {
                self.likes as f64
                    + self.reposts as f64 * 2.5
                    + self.comments as f64 * 2.0
                    + (self.views as f64).sqrt() * 0.15
            }
            Source::Threads => {
                self.likes as f64 + self.reposts as f64 * 2.0 + self.comments as f64 * 2.5
            }
        }
    }

    pub fn compact_label(&self, source: Source) -> String {
        let mut parts = Vec::with_capacity(4);
        match source {
            Source::Github => {
                if self.stars > 0 {
                    parts.push(format!("{}★", fmt_num(self.stars)));
                }
                if self.likes > 0 {
                    parts.push(format!("{}👍", fmt_num(self.likes)));
                }
                if self.comments > 0 {
                    parts.push(format!("{}💬", fmt_num(self.comments)));
                }
            }
            Source::Youtube => {
                if self.views > 0 {
                    parts.push(format!("{}👁", fmt_num(self.views)));
                }
                if self.likes > 0 {
                    parts.push(format!("{}👍", fmt_num(self.likes)));
                }
                if self.comments > 0 {
                    parts.push(format!("{}💬", fmt_num(self.comments)));
                }
            }
            Source::Hn | Source::Reddit => {
                parts.push(format!("{}↑", fmt_num(self.likes)));
                parts.push(format!("{}💬", fmt_num(self.comments)));
            }
            Source::Bluesky | Source::X | Source::Threads => {
                if self.likes > 0 {
                    parts.push(format!("{}♥", fmt_num(self.likes)));
                }
                if self.reposts > 0 {
                    parts.push(format!("{}↻", fmt_num(self.reposts)));
                }
                if self.comments > 0 {
                    parts.push(format!("{}💬", fmt_num(self.comments)));
                }
                if self.views > 0 {
                    parts.push(format!("{}👁", fmt_num(self.views)));
                }
            }
        }
        if parts.is_empty() {
            "-".to_string()
        } else {
            parts.join(" ")
        }
    }
}

pub fn fmt_num(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterRef {
    pub source: Source,
    pub item_id: String,
    pub url: String,
    pub engagement: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    #[serde(default)]
    pub item_id: String,
    pub source: Source,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub text: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    pub author: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub community: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_ts: Option<i64>,
    pub engagement: Engagement,
    #[serde(default)]
    pub score: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub highlights: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub also_on: Vec<ClusterRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceState {
    Ok,
    Degraded,
    Skipped,
    LoginRequired,
    Error,
}

impl fmt::Display for SourceState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SourceState::Ok => f.write_str("ok"),
            SourceState::Degraded => f.write_str("degraded"),
            SourceState::Skipped => f.write_str("skipped"),
            SourceState::LoginRequired => f.write_str("login_required"),
            SourceState::Error => f.write_str("error"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceReport {
    pub source: Source,
    pub status: SourceState,
    pub method: String,
    pub fetched: usize,
    pub kept: usize,
    pub elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchOutput {
    pub query: String,
    pub days: u32,
    pub cutoff_iso: String,
    pub generated_at: String,
    pub elapsed_ms: u64,
    pub sources: Vec<SourceReport>,
    pub items: Vec<Item>,
}

#[derive(Debug, Clone)]
pub struct SourceBatch {
    pub report: SourceReport,
    pub items: Vec<Item>,
}

/// Lenient schema for external JSON ingestion (`--x-json`, `--threads-json`, ego-browser output).
#[derive(Debug, Clone, Deserialize)]
pub struct ExternalItem {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub link: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub community: Option<String>,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub published_ts: Option<i64>,
    #[serde(default)]
    pub likes: u64,
    #[serde(default)]
    pub comments: u64,
    #[serde(default)]
    pub reposts: u64,
    #[serde(default)]
    pub views: u64,
    #[serde(default)]
    pub stars: u64,
    #[serde(default)]
    pub highlights: Vec<String>,
}

impl ExternalItem {
    pub fn into_item(self, source: Source) -> Option<Item> {
        let url = self.url?.trim().to_string();
        if url.is_empty() {
            return None;
        }
        let text = clean_whitespace(&self.text.unwrap_or_default());
        let title = self
            .title
            .map(|t| clean_whitespace(&t))
            .filter(|t| !t.is_empty());
        if text.is_empty() && title.is_none() {
            return None;
        }
        let published_ts = self
            .published_ts
            .or_else(|| self.published_at.as_deref().and_then(parse_timestamp));
        let published_at = self.published_at.or_else(|| published_ts.map(ts_to_iso));
        let id = self.id.unwrap_or_else(|| url.clone());
        let author = self
            .author
            .map(|a| a.trim().trim_start_matches('@').to_string())
            .filter(|a| !a.is_empty())
            .unwrap_or_else(|| "unknown".to_string());
        let link = self
            .link
            .map(|l| l.trim().to_string())
            .filter(|l| l.starts_with("http://") || l.starts_with("https://"));

        Some(Item {
            item_id: String::new(),
            source,
            id,
            title,
            text,
            url,
            link,
            author,
            community: self.community,
            published_at,
            published_ts,
            engagement: Engagement {
                likes: self.likes,
                comments: self.comments,
                reposts: self.reposts,
                views: self.views,
                stars: self.stars,
            },
            score: 0.0,
            highlights: self.highlights,
            also_on: Vec::new(),
        })
    }
}

/// Deterministic 8-char hex ID derived from canonical URL (64-bit FNV-1a).
pub fn short_hash_id(canonical_url: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in canonical_url.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let folded = (hash >> 32) ^ (hash & 0xffff_ffff);
    format!("{folded:08x}")
}

/// Strictly parse a YouTube video ID from an 11-char ID or an allowed YouTube URL.
pub fn parse_youtube_video_id(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if is_valid_yt_id(trimmed) {
        return Some(trimmed.to_string());
    }
    let u = Url::parse(trimmed).ok()?;
    if !matches!(u.scheme(), "http" | "https") {
        return None;
    }
    let host = u.host_str()?.to_ascii_lowercase();
    if host == "youtu.be" {
        let seg = u.path_segments()?.next()?;
        return is_valid_yt_id(seg).then(|| seg.to_string());
    }
    if matches!(host.as_str(), "youtube.com" | "www.youtube.com" | "m.youtube.com") {
        if let Some((_, v)) = u.query_pairs().find(|(k, _)| k == "v")
            && is_valid_yt_id(&v)
        {
            return Some(v.into_owned());
        }
        let segs: Vec<&str> = u.path_segments()?.collect();
        if segs.len() >= 2
            && matches!(segs[0], "shorts" | "embed" | "live")
            && is_valid_yt_id(segs[1])
        {
            return Some(segs[1].to_string());
        }
    }
    None
}

fn is_valid_yt_id(s: &str) -> bool {
    s.len() == 11
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn parse_timestamp(s: &str) -> Option<i64> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(ts) = trimmed.parse::<jiff::Timestamp>() {
        return Some(ts.as_second());
    }
    // ISO-8601 with compact offset like "2026-11-21T10:49:38.296000+0000" (Reddit faceplate-timeago)
    if trimmed.len() > 5 {
        let split = trimmed.len() - 5;
        let bytes = trimmed.as_bytes();
        if (bytes[split] == b'+' || bytes[split] == b'-')
            && bytes[split + 1..].iter().all(|b| b.is_ascii_digit())
        {
            let normalized = format!(
                "{}{}:{}",
                &trimmed[..split],
                &trimmed[split..split + 3],
                &trimmed[split + 3..]
            );
            if let Ok(ts) = normalized.parse::<jiff::Timestamp>() {
                return Some(ts.as_second());
            }
        }
    }
    if let Ok(zoned) = trimmed.parse::<jiff::Zoned>() {
        return Some(zoned.timestamp().as_second());
    }
    // RFC 2822 / X created_at format: "Wed Nov 25 12:34:56 +0000 2026"
    if let Ok(dt) = jiff::fmt::strtime::parse("%a %b %d %H:%M:%S %z %Y", trimmed)
        && let Ok(ts) = dt.to_timestamp()
    {
        return Some(ts.as_second());
    }
    if let Ok(date) = trimmed.parse::<jiff::civil::Date>()
        && let Ok(zoned) = date.at(0, 0, 0, 0).in_tz("UTC")
    {
        return Some(zoned.timestamp().as_second());
    }
    None
}

pub fn ts_to_iso(ts: i64) -> String {
    jiff::Timestamp::from_second(ts)
        .map(|t| t.to_string())
        .unwrap_or_else(|_| ts.to_string())
}

pub fn ts_to_date(ts: i64) -> String {
    jiff::Timestamp::from_second(ts)
        .map(|t| {
            let s = t.to_string();
            s.get(..10).unwrap_or(&s).to_string()
        })
        .unwrap_or_default()
}

pub fn clean_whitespace(input: &str) -> String {
    let mut out = String::with_capacity(input.len().min(512));
    let mut prev_space = true;
    for ch in input.chars() {
        if ch.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

pub fn truncate_chars(input: &str, max_chars: usize) -> String {
    let cleaned = clean_whitespace(input);
    let mut chars = cleaned.chars();
    let taken: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{taken}…")
    } else {
        taken
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_youtube_ids_strictly() {
        assert_eq!(
            parse_youtube_video_id("dQw4w9WgXcQ"),
            Some("dQw4w9WgXcQ".into())
        );
        assert_eq!(
            parse_youtube_video_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s"),
            Some("dQw4w9WgXcQ".into())
        );
        assert_eq!(
            parse_youtube_video_id("https://youtu.be/dQw4w9WgXcQ"),
            Some("dQw4w9WgXcQ".into())
        );
        assert_eq!(
            parse_youtube_video_id("https://youtube.com/shorts/dQw4w9WgXcQ"),
            Some("dQw4w9WgXcQ".into())
        );
        // Reject arbitrary non-YouTube hosts & malformed IDs
        assert_eq!(parse_youtube_video_id("https://evil.example.com/watch?v=dQw4w9WgXcQ"), None);
        assert_eq!(parse_youtube_video_id("https://evil.youtube.com.attacker.io/watch?v=dQw4w9WgXcQ"), None);
        assert_eq!(parse_youtube_video_id("not-an-id"), None);
    }

    #[test]
    fn parses_compact_offset_timestamps() {
        assert!(parse_timestamp("2026-11-21T10:49:38.296000+0000").is_some());
        assert!(parse_timestamp("Wed Nov 25 12:34:56 +0000 2026").is_some());
    }
}
