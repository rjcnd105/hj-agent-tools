mod browser;
mod config;
mod model;
mod rank;
mod render;
mod sources;
mod store;

use anyhow::{Result, bail};
use clap::{Args, Parser, Subcommand};
use config::Config;
use model::{
    SearchOutput, Source, SourceBatch, SourceReport, SourceState, parse_youtube_video_id,
    ts_to_date, ts_to_iso,
};
use rank::{RankOptions, merge_and_rank};
use render::OutputFormat;
use sources::QueryParams;
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Instant;
use tokio::task::JoinSet;

#[derive(Debug, Parser)]
#[command(
    name = "last30",
    version,
    about = "Fast parallel community research CLI (HN, GitHub, Bluesky, Reddit, YouTube, X, Threads)"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Search across selected communities over the last N days
    Search(SearchArgs),
    /// Show full text/metadata for one or more item IDs from the local run store
    Show(ShowArgs),
    /// Check local credentials, browser script path, `gh`, and `ego-browser` health
    Doctor(DoctorArgs),
    /// Extract YouTube transcripts via ego-browser (avoids HTTP 429)
    Transcripts(TranscriptArgs),
}

#[derive(Debug, Args)]
struct SearchArgs {
    /// Topic or query to search
    query: String,

    /// Lookback window in days
    #[arg(long, default_value_t = 30)]
    days: u32,

    /// Comma-separated sources: hn,github,bluesky,reddit,youtube,x,threads
    #[arg(long, value_delimiter = ',')]
    sources: Option<Vec<Source>>,

    /// Skip ego-browser collection (HTTP/API/JSON-file sources only, fastest)
    #[arg(long)]
    no_browser: bool,

    /// Hand off ego-browser space to user if X/Threads requires login
    #[arg(long)]
    handoff: bool,

    /// Also fetch top comments for top Reddit threads (OAuth mode)
    #[arg(long)]
    comments: bool,

    /// Include snippets on titled sources too (hn, github, reddit, youtube)
    #[arg(long)]
    full: bool,

    /// Allow searching private GitHub repos/issues accessible to your token (off by default)
    #[arg(long)]
    include_private_github: bool,

    /// Pre-captured X items JSON file (overrides X API / browser)
    #[arg(long)]
    x_json: Option<PathBuf>,

    /// Pre-captured Threads items JSON file (overrides Threads API / browser)
    #[arg(long)]
    threads_json: Option<PathBuf>,

    /// Raw items to fetch per source before filtering
    #[arg(long, default_value_t = 12)]
    per_source: usize,

    /// Maximum kept items per source in output
    #[arg(long, default_value_t = 6)]
    max_per_source: usize,

    /// Maximum total items in output (keeps LLM context small)
    #[arg(long, default_value_t = 28)]
    max_items: usize,

    /// Max characters per item snippet in compact output
    #[arg(long, default_value_t = 150)]
    max_snippet: usize,

    /// Output format
    #[arg(long, value_enum, default_value_t = OutputFormat::Compact)]
    format: OutputFormat,

    /// Per-request HTTP / browser timeout in seconds
    #[arg(long, default_value_t = 15)]
    timeout: u64,

    /// Custom ego-browser collector JS file (hot-editable without rebuilding Rust)
    #[arg(long, env = "LAST30_BROWSER_SCRIPT")]
    browser_script: Option<PathBuf>,

    /// Print resolved browser script path and raw ego-browser logs to stderr
    #[arg(long)]
    debug_browser: bool,

    /// Write output to file instead of stdout
    #[arg(long, short = 'o')]
    out: Option<PathBuf>,
}

#[derive(Debug, Args)]
struct ShowArgs {
    /// One or more 8-char item IDs printed by `last30 search`
    #[arg(required = true)]
    ids: Vec<String>,

    /// Fetch top comments on demand (supported for HN and Reddit)
    #[arg(long)]
    comments: bool,

    /// Fetch YouTube transcript via ego-browser on demand
    #[arg(long)]
    transcript: bool,

    /// Max transcript characters per video when --transcript is set
    #[arg(long, default_value_t = 4000)]
    max_chars: usize,

    /// Output format
    #[arg(long, value_enum, default_value_t = OutputFormat::Compact)]
    format: OutputFormat,

    /// Custom ego-browser collector JS file
    #[arg(long, env = "LAST30_BROWSER_SCRIPT")]
    browser_script: Option<PathBuf>,

    /// Print resolved browser script path and raw ego-browser logs to stderr
    #[arg(long)]
    debug_browser: bool,
}

#[derive(Debug, Args)]
struct DoctorArgs {
    /// Run a live ego-browser contract probe against X, Threads, and Reddit
    #[arg(long)]
    browser: bool,

    /// Custom ego-browser collector JS file
    #[arg(long, env = "LAST30_BROWSER_SCRIPT")]
    browser_script: Option<PathBuf>,

    /// Print raw ego-browser logs during --browser check
    #[arg(long)]
    debug_browser: bool,
}

#[derive(Debug, Args)]
struct TranscriptArgs {
    /// One or more YouTube video URLs or 11-char IDs
    #[arg(required = true)]
    videos: Vec<String>,

    /// Max transcript characters per video
    #[arg(long, default_value_t = 4000)]
    max_chars: usize,

    /// Output format (compact or json)
    #[arg(long, value_enum, default_value_t = OutputFormat::Compact)]
    format: OutputFormat,

    /// Browser timeout in seconds
    #[arg(long, default_value_t = 45)]
    timeout: u64,

    /// Custom ego-browser collector JS file
    #[arg(long, env = "LAST30_BROWSER_SCRIPT")]
    browser_script: Option<PathBuf>,

    /// Print resolved browser script path and raw ego-browser logs to stderr
    #[arg(long)]
    debug_browser: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Search(args) => run_search(args).await,
        Command::Show(args) => run_show(args).await,
        Command::Doctor(args) => run_doctor(args).await,
        Command::Transcripts(args) => run_transcripts(args).await,
    }
}

async fn run_search(args: SearchArgs) -> Result<()> {
    let started = Instant::now();
    let cfg = Config::load(args.timeout).await;
    let client = cfg.build_http_client()?;

    let now_ts = jiff::Timestamp::now().as_second();
    let cutoff_ts = now_ts - (args.days as i64) * 86_400;
    let cutoff_iso = ts_to_iso(cutoff_ts);
    let cutoff_date = ts_to_date(cutoff_ts);

    let params = QueryParams {
        query: args.query.clone(),
        days: args.days,
        cutoff_ts,
        cutoff_iso: cutoff_iso.clone(),
        cutoff_date,
        per_source: args.per_source,
        fetch_comments: args.comments,
        include_private_github: args.include_private_github,
    };

    let selected: Vec<Source> = match args.sources {
        Some(list) if !list.is_empty() => {
            let mut seen = HashSet::new();
            list.into_iter().filter(|s| seen.insert(*s)).collect()
        }
        _ => {
            if args.no_browser {
                let mut list = Source::FAST_HTTP.to_vec();
                if args.x_json.is_some() || sources::x::has_api_credentials(&cfg) {
                    list.push(Source::X);
                }
                if args.threads_json.is_some() || sources::threads::has_api_credentials(&cfg) {
                    list.push(Source::Threads);
                }
                list
            } else {
                Source::ALL.to_vec()
            }
        }
    };

    let mut join_set: JoinSet<Vec<SourceBatch>> = JoinSet::new();
    let mut browser_sources: Vec<Source> = Vec::new();

    for src in selected {
        match src {
            Source::Hn => {
                let c = client.clone();
                let p = params.clone();
                join_set.spawn(async move { vec![sources::hn::collect(&c, &p).await] });
            }
            Source::Github => {
                let c = client.clone();
                let cfg = cfg.clone();
                let p = params.clone();
                join_set.spawn(async move { vec![sources::github::collect(&c, &cfg, &p).await] });
            }
            Source::Bluesky => {
                let c = client.clone();
                let cfg = cfg.clone();
                let p = params.clone();
                join_set.spawn(async move { vec![sources::bluesky::collect(&c, &cfg, &p).await] });
            }
            Source::Reddit => {
                let has_oauth =
                    cfg.reddit_client_id.is_some() && cfg.reddit_client_secret.is_some();
                if has_oauth || args.no_browser {
                    let c = client.clone();
                    let cfg = cfg.clone();
                    let p = params.clone();
                    join_set
                        .spawn(async move { vec![sources::reddit::collect(&c, &cfg, &p).await] });
                } else {
                    browser_sources.push(Source::Reddit);
                }
            }
            Source::Youtube => {
                let c = client.clone();
                let cfg = cfg.clone();
                let p = params.clone();
                join_set.spawn(async move { vec![sources::youtube::collect(&c, &cfg, &p).await] });
            }
            Source::X => {
                if let Some(path) = args.x_json.clone() {
                    join_set.spawn(async move {
                        vec![sources::load_json_file(Source::X, &path).await]
                    });
                } else if sources::x::has_api_credentials(&cfg) {
                    let c = client.clone();
                    let cfg = cfg.clone();
                    let p = params.clone();
                    join_set.spawn(async move {
                        vec![sources::x::collect_via_api(&c, &cfg, &p).await]
                    });
                } else if !args.no_browser {
                    browser_sources.push(Source::X);
                } else {
                    join_set.spawn(async move {
                        vec![skipped_batch(
                            Source::X,
                            "browser disabled and no X_BEARER_TOKEN/XAI_API_KEY",
                        )]
                    });
                }
            }
            Source::Threads => {
                if let Some(path) = args.threads_json.clone() {
                    join_set.spawn(async move {
                        vec![sources::load_json_file(Source::Threads, &path).await]
                    });
                } else if sources::threads::has_api_credentials(&cfg) {
                    let c = client.clone();
                    let cfg = cfg.clone();
                    let p = params.clone();
                    join_set.spawn(async move {
                        vec![sources::threads::collect_via_api(&c, &cfg, &p).await]
                    });
                } else if !args.no_browser {
                    browser_sources.push(Source::Threads);
                } else {
                    join_set.spawn(async move {
                        vec![skipped_batch(
                            Source::Threads,
                            "browser disabled and no THREADS_ACCESS_TOKEN",
                        )]
                    });
                }
            }
        }
    }

    if !browser_sources.is_empty() {
        let p = params.clone();
        let browser_opts = browser::BrowserOptions {
            handoff: args.handoff,
            timeout_secs: args.timeout,
            script_path: args.browser_script.clone(),
            debug: args.debug_browser,
        };
        join_set.spawn(async move {
            if !browser::is_available().await {
                return browser_sources
                    .into_iter()
                    .map(|s| skipped_batch(s, "ego-browser not installed"))
                    .collect();
            }
            browser::collect_sources(&browser_sources, &p, &browser_opts).await
        });
    }

    let mut all_batches: Vec<SourceBatch> = Vec::new();
    while let Some(res) = join_set.join_next().await {
        if let Ok(batches) = res {
            all_batches.extend(batches);
        }
    }

    let ranked = merge_and_rank(
        all_batches,
        &RankOptions {
            query: &args.query,
            days: args.days,
            now_ts,
            cutoff_ts,
            max_per_source: args.max_per_source,
            max_items: args.max_items,
        },
    );

    // Persist both primary items and absorbed cluster members for `last30 show <id>`
    let store_ok = match store::save_items(&ranked.store_items).await {
        Ok(()) => true,
        Err(e) => {
            eprintln!("last30 warning: failed to save run store ({e}); `last30 show` unavailable");
            false
        }
    };

    let output = SearchOutput {
        query: args.query,
        days: args.days,
        cutoff_iso,
        generated_at: ts_to_iso(now_ts),
        elapsed_ms: started.elapsed().as_millis() as u64,
        sources: ranked.reports,
        items: ranked.items,
    };

    let rendered = render::render(&output, args.format, args.max_snippet, args.full, store_ok)?;
    if let Some(out_path) = args.out {
        tokio::fs::write(&out_path, rendered).await?;
    } else {
        print!("{rendered}");
    }
    Ok(())
}

async fn run_show(args: ShowArgs) -> Result<()> {
    let cfg = Config::load(15).await;
    let client = cfg.build_http_client()?;
    let mut items = Vec::with_capacity(args.ids.len());

    for id in &args.ids {
        items.push(store::load_item(id).await?);
    }

    if args.comments {
        for item in &mut items {
            match item.source {
                Source::Hn => {
                    let c = sources::hn::fetch_top_comments(&client, &item.id).await;
                    if !c.is_empty() {
                        item.highlights = c;
                    }
                }
                Source::Reddit => {
                    let c = sources::reddit::fetch_comments_with_config(&client, &cfg, &item.url)
                        .await;
                    if !c.is_empty() {
                        item.highlights = c;
                    }
                }
                _ => {}
            }
        }
    }

    if args.transcript {
        let yt_indices: Vec<(usize, String)> = items
            .iter()
            .enumerate()
            .filter(|(_, it)| it.source == Source::Youtube)
            .filter_map(|(i, it)| {
                let vid = parse_youtube_video_id(&it.url)
                    .or_else(|| parse_youtube_video_id(&it.id))?;
                Some((i, format!("https://www.youtube.com/watch?v={vid}")))
            })
            .collect();

        if !yt_indices.is_empty() {
            let urls: Vec<String> = yt_indices.iter().map(|(_, u)| u.clone()).collect();
            let browser_opts = browser::BrowserOptions {
                handoff: false,
                timeout_secs: 45,
                script_path: args.browser_script.clone(),
                debug: args.debug_browser,
            };
            let payload = browser::collect_transcripts(&urls, args.max_chars, &browser_opts).await?;
            for ((idx, _), entry) in yt_indices.into_iter().zip(payload.results.into_iter()) {
                if !entry.transcript.is_empty() {
                    items[idx].highlights.push(format!(
                        "[transcript:{}] {}",
                        entry.lang.unwrap_or_else(|| "?".into()),
                        entry.transcript
                    ));
                } else {
                    let detail = entry
                        .note
                        .map(|n| format!(": {n}"))
                        .unwrap_or_default();
                    items[idx]
                        .highlights
                        .push(format!("[transcript:{}]{detail}", entry.status));
                }
            }
        }
    }

    print!("{}", render::render_show(&items, args.format)?);
    Ok(())
}

async fn run_doctor(args: DoctorArgs) -> Result<()> {
    let cfg = Config::load(5).await;
    let ego_ok = browser::is_available().await;
    let script_info = match browser::resolve_script(args.browser_script.as_deref()).await {
        Ok(r) if r.is_live_file => format!("{} (live, hot-editable)", r.origin),
        Ok(r) => format!("{} (fallback)", r.origin),
        Err(e) => format!("ERROR: {e}"),
    };

    println!("last30 doctor");
    match &cfg.env_path {
        Some(p) => println!(
            "  env file      : {} ({})",
            p.display(),
            if p.exists() { "found" } else { "not found (optional)" }
        ),
        None => println!("  env file      : none (HOME unset)"),
    }
    println!(
        "  ego-browser   : {}",
        if ego_ok { "available" } else { "not found" }
    );
    println!("  browser script: {script_info}");
    if let Some(sd) = store::store_dir() {
        println!("  run store     : {}", sd.display());
    }
    if let Some(dd) = store::dumps_dir() {
        println!("  failure dumps : {}", dd.display());
    }
    println!();
    println!("Sources:");
    println!("  hn       : ready (algolia-api, zero-config)");
    println!(
        "  github   : ready ({}, is:public enforced)",
        cfg.github_token_source.unwrap_or("anon, 10 req/min")
    );
    println!(
        "  bluesky  : ready ({})",
        if cfg.bsky_handle.is_some() && cfg.bsky_app_password.is_some() {
            "atproto-auth"
        } else {
            "atproto-public via api.bsky.app, zero-config"
        }
    );
    println!(
        "  reddit   : ready ({})",
        if cfg.reddit_client_id.is_some() && cfg.reddit_client_secret.is_some() {
            "reddit-oauth"
        } else if ego_ok {
            "ego-browser (set REDDIT_CLIENT_ID/SECRET for headless OAuth)"
        } else {
            "reddit-json (set REDDIT_CLIENT_ID/SECRET or install ego-browser)"
        }
    );
    println!(
        "  youtube  : ready ({})",
        if cfg.youtube_api_key.is_some() {
            "youtube-api v3"
        } else {
            "youtube-web (set YOUTUBE_API_KEY for exact like/comment counts)"
        }
    );
    println!(
        "  x        : {}",
        if cfg.x_bearer_token.is_some() {
            "ready (x-api-v2)"
        } else if cfg.xai_api_key.is_some() {
            "ready (xai-x-search)"
        } else if ego_ok {
            "ready (ego-browser; or pass --x-json)"
        } else {
            "unavailable (install ego-browser or set XAI_API_KEY / X_BEARER_TOKEN)"
        }
    );
    println!(
        "  threads  : {}",
        if cfg.threads_access_token.is_some() {
            "ready (threads-api)"
        } else if ego_ok {
            "ready (ego-browser; or pass --threads-json)"
        } else {
            "unavailable (install ego-browser or set THREADS_ACCESS_TOKEN)"
        }
    );

    if args.browser {
        if !ego_ok {
            bail!("--browser health check requested but ego-browser is unavailable");
        }
        println!("\nLive browser contract check (query=\"rust\", 30d):");
        let now_ts = jiff::Timestamp::now().as_second();
        let cutoff_ts = now_ts - 30 * 86_400;
        let params = QueryParams {
            query: "rust".to_string(),
            days: 30,
            cutoff_ts,
            cutoff_iso: ts_to_iso(cutoff_ts),
            cutoff_date: ts_to_date(cutoff_ts),
            per_source: 8,
            fetch_comments: false,
            include_private_github: false,
        };
        let opts = browser::BrowserOptions {
            handoff: false,
            timeout_secs: 25,
            script_path: args.browser_script,
            debug: args.debug_browser,
        };
        let batches = browser::collect_sources(
            &[Source::Reddit, Source::X, Source::Threads],
            &params,
            &opts,
        )
        .await;
        let ranked = merge_and_rank(
            batches,
            &RankOptions {
                query: "rust",
                days: 30,
                now_ts,
                cutoff_ts,
                max_per_source: 8,
                max_items: 24,
            },
        );
        let mut failed = 0usize;
        for r in &ranked.reports {
            if matches!(r.status, SourceState::Error | SourceState::Degraded) {
                failed += 1;
            }
            print!(
                "  {:<8} : {} ({}/{}, {}ms, {})",
                r.source, r.status, r.kept, r.fetched, r.elapsed_ms, r.method
            );
            if let Some(n) = &r.note {
                print!(" — {n}");
            }
            println!();
        }
        if failed > 0 {
            bail!("{failed} browser source(s) reported error or degraded");
        }
    }
    Ok(())
}

async fn run_transcripts(args: TranscriptArgs) -> Result<()> {
    let mut urls = Vec::with_capacity(args.videos.len());
    for raw in &args.videos {
        let Some(vid) = parse_youtube_video_id(raw) else {
            bail!(
                "invalid YouTube video URL or 11-char ID: `{raw}` (only youtube.com/youtu.be URLs or 11-char IDs are allowed)"
            );
        };
        urls.push(format!("https://www.youtube.com/watch?v={vid}"));
    }

    let browser_opts = browser::BrowserOptions {
        handoff: false,
        timeout_secs: args.timeout,
        script_path: args.browser_script,
        debug: args.debug_browser,
    };
    let payload = browser::collect_transcripts(&urls, args.max_chars, &browser_opts).await?;
    match args.format {
        OutputFormat::Json | OutputFormat::Ndjson => {
            println!("{}", serde_json::to_string_pretty(&payload)?);
        }
        OutputFormat::Compact => {
            for r in &payload.results {
                println!(
                    "## {} ({}) | {} | lang={} | status={}",
                    r.title,
                    r.author,
                    r.url,
                    r.lang.as_deref().unwrap_or("-"),
                    r.status
                );
                if let Some(note) = &r.note {
                    println!("note: {note}");
                }
                if !r.transcript.is_empty() {
                    println!("{}\n", r.transcript);
                }
            }
        }
    }
    Ok(())
}

fn skipped_batch(source: Source, reason: &str) -> SourceBatch {
    SourceBatch {
        report: SourceReport {
            source,
            status: SourceState::Skipped,
            method: "skipped".to_string(),
            fetched: 0,
            kept: 0,
            elapsed_ms: 0,
            note: Some(reason.to_string()),
        },
        items: Vec::new(),
    }
}
