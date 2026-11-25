use anyhow::Result;
use reqwest::Client;
use std::env;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

#[derive(Debug, Clone)]
pub struct Config {
    pub env_path: Option<PathBuf>,
    pub github_token: Option<String>,
    pub github_token_source: Option<&'static str>,
    pub reddit_client_id: Option<String>,
    pub reddit_client_secret: Option<String>,
    pub reddit_user_agent: String,
    pub bsky_handle: Option<String>,
    pub bsky_app_password: Option<String>,
    pub youtube_api_key: Option<String>,
    pub xai_api_key: Option<String>,
    pub x_bearer_token: Option<String>,
    pub threads_access_token: Option<String>,
    pub threads_user_id: Option<String>,
    pub timeout_secs: u64,
}

pub fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

impl Config {
    pub async fn load(timeout_secs: u64) -> Self {
        let env_path = env::var_os("LAST30_ENV")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| home_dir().map(|h| h.join(".config/last30/.env")));
        if let Some(path) = &env_path {
            let _ = dotenvy::from_path(path);
        }

        let (github_token, github_token_source) = match non_empty_env("GITHUB_TOKEN") {
            Some(tok) => (Some(tok), Some("env:GITHUB_TOKEN")),
            None => match non_empty_env("GH_TOKEN") {
                Some(tok) => (Some(tok), Some("env:GH_TOKEN")),
                None => match gh_auth_token().await {
                    Some(tok) => (Some(tok), Some("gh-cli")),
                    None => (None, None),
                },
            },
        };

        let reddit_user_agent = non_empty_env("REDDIT_USER_AGENT")
            .unwrap_or_else(|| "macos:hj-last30:v0.1.0 (by /u/last30_cli)".to_string());

        Self {
            env_path,
            github_token,
            github_token_source,
            reddit_client_id: non_empty_env("REDDIT_CLIENT_ID"),
            reddit_client_secret: non_empty_env("REDDIT_CLIENT_SECRET"),
            reddit_user_agent,
            bsky_handle: non_empty_env("BSKY_HANDLE"),
            bsky_app_password: non_empty_env("BSKY_APP_PASSWORD"),
            youtube_api_key: non_empty_env("YOUTUBE_API_KEY"),
            xai_api_key: non_empty_env("XAI_API_KEY"),
            x_bearer_token: non_empty_env("X_BEARER_TOKEN"),
            threads_access_token: non_empty_env("THREADS_ACCESS_TOKEN"),
            threads_user_id: non_empty_env("THREADS_USER_ID"),
            timeout_secs,
        }
    }

    pub fn build_http_client(&self) -> Result<Client> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(self.timeout_secs))
            .pool_max_idle_per_host(8)
            .tcp_nodelay(true)
            .user_agent("last30/0.1 (+https://github.com/rjcnd105/hj-agent-tools)")
            .build()?;
        Ok(client)
    }
}

fn non_empty_env(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

async fn gh_auth_token() -> Option<String> {
    let mut child = Command::new("gh")
        .args(["auth", "token"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;

    let mut stdout = child.stdout.take()?;
    let read_fut = async {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf).await;
        let status = child.wait().await.ok()?;
        Some((status, buf))
    };

    match tokio::time::timeout(Duration::from_secs(2), read_fut).await {
        Ok(Some((status, buf))) if status.success() => {
            let tok = String::from_utf8(buf).ok()?.trim().to_string();
            if tok.is_empty() { None } else { Some(tok) }
        }
        _ => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            None
        }
    }
}
