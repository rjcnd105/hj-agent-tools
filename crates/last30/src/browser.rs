use crate::config::home_dir;
use crate::model::{ExternalItem, Source, SourceBatch, SourceReport, SourceState};
use crate::sources::QueryParams;
use crate::store;
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

#[cfg(unix)]
use std::os::unix::fs::DirBuilderExt;

const EMBEDDED_EGO_SCRIPT: &str = include_str!("../../../skills/last30/scripts/ego-collect.js");
const REPO_SKILL_SCRIPT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../skills/last30/scripts/ego-collect.js"
);
const EXPECTED_SCHEMA_VERSION: u32 = 1;

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
pub struct ResolvedScript {
    pub origin: String,
    pub body: String,
    pub is_live_file: bool,
}

fn script_candidates() -> Vec<PathBuf> {
    let mut list = Vec::with_capacity(2);
    if let Some(home) = home_dir() {
        list.push(home.join(".config/last30/ego-collect.js"));
    }
    let repo_path = PathBuf::from(REPO_SKILL_SCRIPT);
    if let Ok(canon) = std::fs::canonicalize(&repo_path) {
        list.push(canon);
    } else {
        list.push(repo_path);
    }
    list
}

/// Resolve the ego-browser collector script dynamically (single source of truth for
/// both runtime execution and `last30 doctor`).
pub async fn resolve_script(explicit: Option<&Path>) -> Result<ResolvedScript> {
    if let Some(path) = explicit {
        let body = tokio::fs::read_to_string(path)
            .await
            .with_context(|| format!("failed to read --browser-script {}", path.display()))?;
        return Ok(ResolvedScript {
            origin: path.display().to_string(),
            body,
            is_live_file: true,
        });
    }

    for path in script_candidates() {
        if let Ok(body) = tokio::fs::read_to_string(&path).await {
            return Ok(ResolvedScript {
                origin: path.display().to_string(),
                body,
                is_live_file: true,
            });
        }
    }

    Ok(ResolvedScript {
        origin: "embedded".to_string(),
        body: EMBEDDED_EGO_SCRIPT.to_string(),
        is_live_file: false,
    })
}

/// RAII private `0700` per-run temporary directory to prevent symlink attacks or world-readable leaks.
struct TempRunDir {
    path: PathBuf,
}

impl TempRunDir {
    fn create(tag: &str) -> Result<Self> {
        let base = env::temp_dir();
        let pid = std::process::id();
        for attempt in 0..16u64 {
            let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let ts = jiff::Timestamp::now().as_nanosecond();
            let dir = base.join(format!("last30-{tag}-{pid}-{ts:x}-{seq}-{attempt}"));
            let mut builder = std::fs::DirBuilder::new();
            builder.recursive(false);
            #[cfg(unix)]
            builder.mode(0o700);
            match builder.create(&dir) {
                Ok(()) => return Ok(Self { path: dir }),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => {
                    return Err(e).with_context(|| {
                        format!("failed to create private temp dir {}", dir.display())
                    });
                }
            }
        }
        bail!("failed to allocate unique private temp dir after 16 attempts");
    }

    fn file(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }
}

impl Drop for TempRunDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

#[derive(Debug, Deserialize)]
struct BrowserCollectPayload {
    #[serde(default)]
    schema: Option<u32>,
    #[serde(rename = "taskSpaceId", default)]
    task_space_id: Option<u64>,
    #[serde(rename = "handedOff", default)]
    handed_off: bool,
    #[serde(default)]
    batches: Vec<BrowserBatchRaw>,
}

#[derive(Debug, Deserialize)]
struct BrowserBatchRaw {
    source: String,
    status: String,
    method: String,
    #[serde(default)]
    elapsed_ms: u64,
    #[serde(default)]
    note: Option<String>,
    #[serde(rename = "dumpPath", default)]
    dump_path: Option<String>,
    #[serde(default)]
    items: Vec<ExternalItem>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TranscriptPayload {
    #[serde(default)]
    pub schema: Option<u32>,
    #[serde(rename = "taskSpaceId", default)]
    pub task_space_id: Option<u64>,
    #[serde(default)]
    pub results: Vec<TranscriptEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TranscriptEntry {
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub lang: Option<String>,
    pub status: String,
    #[serde(default)]
    pub elapsed_ms: u64,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub transcript: String,
}

#[derive(Debug, Clone)]
pub struct BrowserOptions {
    pub handoff: bool,
    pub timeout_secs: u64,
    pub script_path: Option<PathBuf>,
    pub debug: bool,
}

pub async fn is_available() -> bool {
    let Ok(mut child) = Command::new("ego-browser")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    else {
        return false;
    };

    match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
        Ok(Ok(st)) => st.success(),
        _ => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            false
        }
    }
}

pub async fn collect_sources(
    sources: &[Source],
    params: &QueryParams,
    opts: &BrowserOptions,
) -> Vec<SourceBatch> {
    if sources.is_empty() {
        return Vec::new();
    }
    let start = Instant::now();
    let resolved = match resolve_script(opts.script_path.as_deref()).await {
        Ok(r) => r,
        Err(e) => return error_batches(sources, start, e.to_string()),
    };
    if opts.debug {
        eprintln!("[last30:browser] script={}", resolved.origin);
    }

    let tmp_dir = match TempRunDir::create("collect") {
        Ok(d) => d,
        Err(e) => return error_batches(sources, start, e.to_string()),
    };
    let out_path = tmp_dir.file("result.json");

    let dumps_dir = store::dumps_dir().and_then(|d| {
        store::ensure_private_dir(&d).ok()?;
        Some(d.to_string_lossy().into_owned())
    });

    let reddit_bucket = match params.days {
        0..=1 => "day",
        2..=7 => "week",
        8..=31 => "month",
        _ => "year",
    };

    let global_timeout_secs = opts.timeout_secs.max(20);
    let cfg_json = serde_json::json!({
        "schema": EXPECTED_SCHEMA_VERSION,
        "mode": "search",
        "sources": sources.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
        "query": params.query,
        "cutoffDate": params.cutoff_date,
        "cutoffTs": params.cutoff_ts,
        "redditBucket": reddit_bucket,
        "limit": params.per_source.clamp(5, 25),
        "deadlineMs": 5500,
        "globalDeadlineMs": global_timeout_secs * 1000,
        "handoff": opts.handoff,
        "dumpsDir": dumps_dir,
        "outPath": out_path.to_string_lossy(),
    });

    let script = format!("const CONFIG = {cfg_json};\n{}", resolved.body);
    let run_res = run_ego_script(
        &script,
        Duration::from_secs(global_timeout_secs),
        opts.debug,
    )
    .await;

    // Even if `ego-browser` timed out or exited non-zero, try salvaging any checkpointed batches!
    let run_err = run_res.err().map(|e| e.to_string());
    let mut batches = match tokio::fs::read_to_string(&out_path).await {
        Ok(raw) => {
            if opts.debug {
                eprintln!("[last30:browser] raw_bytes={}", raw.len());
            }
            match serde_json::from_str::<BrowserCollectPayload>(&raw) {
                Ok(payload) => {
                    if payload.schema != Some(EXPECTED_SCHEMA_VERSION) {
                        return error_batches(
                            sources,
                            start,
                            format!(
                                "ego-collect.js schema mismatch (got {:?}, expected {EXPECTED_SCHEMA_VERSION})",
                                payload.schema
                            ),
                        );
                    }
                    let requested_set: HashSet<Source> = sources.iter().copied().collect();
                    let mut parsed = Vec::with_capacity(payload.batches.len());
                    for b in payload.batches {
                        let Ok(src) = b.source.parse::<Source>() else {
                            continue;
                        };
                        if !requested_set.contains(&src) {
                            continue;
                        }
                        let state = match b.status.as_str() {
                            "ok" => SourceState::Ok,
                            "degraded" => SourceState::Degraded,
                            "login_required" => SourceState::LoginRequired,
                            "skipped" => SourceState::Skipped,
                            _ => SourceState::Error,
                        };
                        let mut note_parts = Vec::new();
                        if let Some(n) = b.note
                            && !n.trim().is_empty()
                        {
                            note_parts.push(n);
                        }
                        if state == SourceState::LoginRequired
                            && payload.handed_off
                            && let Some(sid) = payload.task_space_id
                        {
                            note_parts.push(format!("ego-browser taskSpaceId={sid} handed off"));
                        }
                        if let Some(dp) = b.dump_path {
                            note_parts.push(format!("dump={dp}"));
                        }
                        let note = (!note_parts.is_empty()).then(|| note_parts.join("; "));
                        let items: Vec<_> =
                            b.items.into_iter().filter_map(|e| e.into_item(src)).collect();
                        let fetched = items.len();
                        parsed.push(SourceBatch {
                            report: SourceReport {
                                source: src,
                                status: state,
                                method: b.method,
                                fetched,
                                kept: fetched,
                                elapsed_ms: b.elapsed_ms,
                                note,
                            },
                            items,
                        });
                    }
                    parsed
                }
                Err(e) => {
                    return error_batches(
                        sources,
                        start,
                        run_err.unwrap_or_else(|| format!("invalid ego-browser JSON: {e}")),
                    );
                }
            }
        }
        Err(e) => {
            return error_batches(
                sources,
                start,
                run_err.unwrap_or_else(|| format!("ego-browser output missing: {e}")),
            );
        }
    };

    // Fill any requested source that was missing from checkpointed batches as an explicit error
    let returned: HashSet<Source> = batches.iter().map(|b| b.report.source).collect();
    let elapsed_ms = start.elapsed().as_millis() as u64;
    for &src in sources {
        if !returned.contains(&src) {
            batches.push(SourceBatch {
                report: SourceReport {
                    source: src,
                    status: SourceState::Error,
                    method: "ego-browser".to_string(),
                    fetched: 0,
                    kept: 0,
                    elapsed_ms,
                    note: Some(
                        run_err
                            .clone()
                            .unwrap_or_else(|| "source missing from ego-browser payload".to_string()),
                    ),
                },
                items: Vec::new(),
            });
        }
    }

    batches
}

pub async fn collect_transcripts(
    canonical_urls: &[String],
    max_chars: usize,
    opts: &BrowserOptions,
) -> Result<TranscriptPayload> {
    let resolved = resolve_script(opts.script_path.as_deref()).await?;
    if opts.debug {
        eprintln!("[last30:browser] script={}", resolved.origin);
    }
    let tmp_dir = TempRunDir::create("transcripts")?;
    let out_path = tmp_dir.file("result.json");
    let cfg_json = serde_json::json!({
        "schema": EXPECTED_SCHEMA_VERSION,
        "mode": "transcripts",
        "urls": canonical_urls,
        "maxChars": max_chars,
        "outPath": out_path.to_string_lossy(),
    });
    let script = format!("const CONFIG = {cfg_json};\n{}", resolved.body);
    run_ego_script(
        &script,
        Duration::from_secs(opts.timeout_secs.max(30)),
        opts.debug,
    )
    .await?;
    let raw = tokio::fs::read_to_string(&out_path)
        .await
        .with_context(|| "ego-browser did not write transcript output")?;
    let payload: TranscriptPayload = serde_json::from_str(&raw)?;
    if payload.schema != Some(EXPECTED_SCHEMA_VERSION) {
        bail!(
            "ego-collect.js schema mismatch (got {:?}, expected {EXPECTED_SCHEMA_VERSION})",
            payload.schema
        );
    }
    Ok(payload)
}

/// Spawn `ego-browser nodejs`, stream script stdin, and wait under ONE unified deadline,
/// killing and reaping the child process if the deadline expires.
async fn run_ego_script(script: &str, timeout: Duration, debug: bool) -> Result<()> {
    let mut child = Command::new("ego-browser")
        .arg("nodejs")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("failed to spawn `ego-browser nodejs` (is ego lite installed?)")?;

    let mut stdin = child.stdin.take();
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let script_bytes = script.as_bytes();

    let io_and_wait = async {
        let write_fut = async {
            if let Some(mut s) = stdin.take() {
                s.write_all(script_bytes).await?;
                s.shutdown().await?;
            }
            Ok::<(), std::io::Error>(())
        };
        let read_out_fut = async {
            let mut buf = Vec::new();
            if let Some(mut o) = stdout.take() {
                let _ = o.read_to_end(&mut buf).await;
            }
            buf
        };
        let read_err_fut = async {
            let mut buf = Vec::new();
            if let Some(mut e) = stderr.take() {
                let _ = e.read_to_end(&mut buf).await;
            }
            buf
        };

        let (write_res, out_buf, err_buf) = tokio::join!(write_fut, read_out_fut, read_err_fut);
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((write_res, status, out_buf, err_buf))
    };

    let (write_res, status, out_buf, err_buf) = match tokio::time::timeout(timeout, io_and_wait).await
    {
        Ok(res) => res?,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            bail!("ego-browser timed out after {}s", timeout.as_secs());
        }
    };

    let stdout_s = String::from_utf8_lossy(&out_buf);
    let stderr_s = String::from_utf8_lossy(&err_buf);
    if debug {
        if !stdout_s.trim().is_empty() {
            eprintln!("[last30:browser:stdout]\n{}", stdout_s.trim());
        }
        if !stderr_s.trim().is_empty() {
            eprintln!("[last30:browser:stderr]\n{}", stderr_s.trim());
        }
    }

    if !status.success() {
        let detail = if !stderr_s.trim().is_empty() {
            stderr_s.trim()
        } else {
            stdout_s.trim()
        };
        bail!("ego-browser exited {status}: {detail}");
    }
    if let Err(e) = write_res {
        bail!("failed writing script to ego-browser stdin: {e}");
    }
    Ok(())
}

fn error_batches(sources: &[Source], start: Instant, msg: String) -> Vec<SourceBatch> {
    let elapsed_ms = start.elapsed().as_millis() as u64;
    sources
        .iter()
        .map(|&source| SourceBatch {
            report: SourceReport {
                source,
                status: SourceState::Error,
                method: "ego-browser".to_string(),
                fetched: 0,
                kept: 0,
                elapsed_ms,
                note: Some(msg.clone()),
            },
            items: Vec::new(),
        })
        .collect()
}
