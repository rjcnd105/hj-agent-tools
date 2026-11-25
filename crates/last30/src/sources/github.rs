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
struct IssuesResponse {
    #[serde(default)]
    items: Vec<GhIssue>,
}

#[derive(Debug, Deserialize)]
struct GhIssue {
    id: u64,
    title: String,
    #[serde(default)]
    body: Option<String>,
    html_url: String,
    #[serde(default)]
    repository_url: Option<String>,
    #[serde(default)]
    user: Option<GhUser>,
    #[serde(default)]
    comments: u64,
    #[serde(default)]
    reactions: Option<GhReactions>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ReposResponse {
    #[serde(default)]
    items: Vec<GhRepo>,
}

#[derive(Debug, Deserialize)]
struct GhRepo {
    id: u64,
    full_name: String,
    #[serde(default)]
    description: Option<String>,
    html_url: String,
    #[serde(default)]
    owner: Option<GhUser>,
    #[serde(default)]
    stargazers_count: u64,
    #[serde(default)]
    forks_count: u64,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    pushed_at: Option<String>,
    #[serde(default)]
    language: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhUser {
    login: String,
}

#[derive(Debug, Deserialize)]
struct GhReactions {
    #[serde(default)]
    total_count: u64,
}

pub async fn collect(client: &Client, cfg: &Config, params: &QueryParams) -> SourceBatch {
    let start = Instant::now();
    let issue_limit = ((params.per_source * 2) / 3).clamp(4, 20).to_string();
    let repo_limit = (params.per_source / 2).clamp(3, 12).to_string();

    let visibility = if params.include_private_github {
        ""
    } else {
        " is:public"
    };
    let issue_q = format!(
        "{}{} updated:>={}",
        params.query, visibility, params.cutoff_date
    );
    // Filter newly created repos in the window so 150k-star legacy repos do not drown out 30d signals
    let repo_q = format!(
        "{}{} created:>={}",
        params.query, visibility, params.cutoff_date
    );

    let mut issue_req = client
        .get("https://api.github.com/search/issues")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .query(&[
            ("q", issue_q.as_str()),
            ("sort", "reactions-+1"),
            ("order", "desc"),
            ("per_page", issue_limit.as_str()),
        ]);

    let mut repo_req = client
        .get("https://api.github.com/search/repositories")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .query(&[
            ("q", repo_q.as_str()),
            ("sort", "stars"),
            ("order", "desc"),
            ("per_page", repo_limit.as_str()),
        ]);

    if let Some(token) = &cfg.github_token {
        issue_req = issue_req.bearer_auth(token);
        repo_req = repo_req.bearer_auth(token);
    }

    let (issue_res, repo_res) = tokio::join!(issue_req.send(), repo_req.send());

    let mut items = Vec::new();
    let mut first_err: Option<String> = None;

    match issue_res {
        Ok(resp) if resp.status().is_success() => match resp.json::<IssuesResponse>().await {
            Ok(data) => {
                for issue in data.items {
                    let repo = issue
                        .repository_url
                        .as_deref()
                        .and_then(|u| u.split("/repos/").nth(1))
                        .map(str::to_string);
                    let ts_str = issue.updated_at.or(issue.created_at);
                    let ts = ts_str.as_deref().and_then(parse_timestamp);
                    let body = issue
                        .body
                        .as_deref()
                        .map(clean_whitespace)
                        .unwrap_or_default();
                    items.push(Item {
                        item_id: String::new(),
                        source: Source::Github,
                        id: format!("issue:{}", issue.id),
                        title: Some(clean_whitespace(&issue.title)),
                        text: body,
                        url: issue.html_url,
                        link: None,
                        author: issue
                            .user
                            .map(|u| u.login)
                            .unwrap_or_else(|| "unknown".to_string()),
                        community: repo,
                        published_at: ts_str,
                        published_ts: ts,
                        engagement: Engagement {
                            likes: issue.reactions.map(|r| r.total_count).unwrap_or(0),
                            comments: issue.comments,
                            ..Default::default()
                        },
                        score: 0.0,
                        highlights: Vec::new(),
                        also_on: Vec::new(),
                    });
                }
            }
            Err(e) => first_err = Some(format!("issues decode: {}", sanitize_reqwest_err(e))),
        },
        Ok(resp) => first_err = Some(format!("issues HTTP {}", resp.status())),
        Err(e) => first_err = Some(sanitize_reqwest_err(e)),
    }

    match repo_res {
        Ok(resp) if resp.status().is_success() => match resp.json::<ReposResponse>().await {
            Ok(data) => {
                for repo in data.items {
                    let ts_str = repo.created_at.or(repo.pushed_at);
                    let ts = ts_str.as_deref().and_then(parse_timestamp);
                    let desc = repo
                        .description
                        .as_deref()
                        .map(clean_whitespace)
                        .unwrap_or_default();
                    let text = match repo.language {
                        Some(lang) if !desc.is_empty() => format!("[{lang}] {desc}"),
                        Some(lang) => format!("[{lang}]"),
                        None => desc,
                    };
                    items.push(Item {
                        item_id: String::new(),
                        source: Source::Github,
                        id: format!("repo:{}", repo.id),
                        title: Some(repo.full_name.clone()),
                        text,
                        url: repo.html_url,
                        link: None,
                        author: repo
                            .owner
                            .map(|o| o.login)
                            .unwrap_or_else(|| "unknown".to_string()),
                        community: Some(repo.full_name),
                        published_at: ts_str,
                        published_ts: ts,
                        engagement: Engagement {
                            stars: repo.stargazers_count,
                            reposts: repo.forks_count,
                            ..Default::default()
                        },
                        score: 0.0,
                        highlights: Vec::new(),
                        also_on: Vec::new(),
                    });
                }
            }
            Err(e) => {
                if first_err.is_none() {
                    first_err = Some(format!("repos decode: {}", sanitize_reqwest_err(e)));
                }
            }
        },
        Ok(resp) => {
            if first_err.is_none() {
                first_err = Some(format!("repos HTTP {}", resp.status()));
            }
        }
        Err(e) => {
            if first_err.is_none() {
                first_err = Some(sanitize_reqwest_err(e));
            }
        }
    }

    let method = match cfg.github_token_source {
        Some(src) => format!("gh-rest({src})"),
        None => "gh-rest(anon)".to_string(),
    };
    let fetched = items.len();
    let (status, note) = if fetched > 0 || first_err.is_none() {
        (SourceState::Ok, None)
    } else {
        (SourceState::Error, first_err)
    };

    SourceBatch {
        report: SourceReport {
            source: Source::Github,
            status,
            method,
            fetched,
            kept: fetched,
            elapsed_ms: start.elapsed().as_millis() as u64,
            note,
        },
        items,
    }
}
