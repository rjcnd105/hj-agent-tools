use crate::model::{Item, SearchOutput, truncate_chars, ts_to_date};
use clap::ValueEnum;
use std::fmt::Write;

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum OutputFormat {
    Compact,
    Json,
    Ndjson,
}

pub fn render(
    output: &SearchOutput,
    format: OutputFormat,
    max_snippet: usize,
    full_snippets: bool,
    show_detail_tip: bool,
) -> anyhow::Result<String> {
    match format {
        OutputFormat::Compact => Ok(render_compact(
            output,
            max_snippet,
            full_snippets,
            show_detail_tip,
        )),
        OutputFormat::Json => Ok(serde_json::to_string_pretty(output)?),
        OutputFormat::Ndjson => {
            let mut buf = String::new();
            for item in &output.items {
                buf.push_str(&serde_json::to_string(item)?);
                buf.push('\n');
            }
            Ok(buf)
        }
    }
}

fn render_compact(
    out: &SearchOutput,
    max_snippet: usize,
    full_snippets: bool,
    show_detail_tip: bool,
) -> String {
    let mut s = String::with_capacity(4096);
    let cutoff_date = out.cutoff_iso.get(..10).unwrap_or(&out.cutoff_iso);
    let _ = writeln!(
        s,
        "# last30: \"{}\" ({}d, since {}, {:.2}s)",
        out.query,
        out.days,
        cutoff_date,
        out.elapsed_ms as f64 / 1000.0
    );
    s.push_str("\n## Sources\n");
    for src in &out.sources {
        let _ = write!(
            s,
            "- {}: {} ({}/{}, {}ms, {})",
            src.source, src.status, src.kept, src.fetched, src.elapsed_ms, src.method
        );
        if let Some(note) = &src.note {
            let _ = write!(s, " — {}", truncate_chars(note, 160));
        }
        s.push('\n');
    }

    let _ = writeln!(s, "\n## Items ({})", out.items.len());
    for it in &out.items {
        let date = it
            .published_ts
            .map(ts_to_date)
            .or_else(|| {
                it.published_at
                    .as_deref()
                    .and_then(|p| p.get(..10))
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "?".to_string());
        let eng = it.engagement.compact_label(it.source);
        let scope = match &it.community {
            Some(c)
                if !c.eq_ignore_ascii_case(it.source.as_str())
                    && c != "Hacker News"
                    && c != "Bluesky"
                    && c != "X"
                    && c != "Threads" =>
            {
                format!("{}:{}", it.source, c)
            }
            _ => it.source.as_str().to_string(),
        };

        let show_body = full_snippets || !it.source.has_titles();

        if let Some(title) = &it.title {
            let _ = writeln!(
                s,
                "- [{}] [{}] **{}** | @{} | {} | {} | {}",
                it.item_id,
                scope,
                truncate_chars(title, 120),
                it.author,
                date,
                eng,
                it.url
            );
            if show_body && !it.text.is_empty() && max_snippet > 0 {
                let _ = writeln!(s, "  {}", truncate_chars(&it.text, max_snippet));
            }
        } else {
            let _ = writeln!(
                s,
                "- [{}] [{}] @{} | {} | {} | {}",
                it.item_id, scope, it.author, date, eng, it.url
            );
            if !it.text.is_empty() && max_snippet > 0 {
                let _ = writeln!(s, "  {}", truncate_chars(&it.text, max_snippet));
            }
        }

        if !it.also_on.is_empty() {
            let refs: Vec<String> = it
                .also_on
                .iter()
                .map(|c| format!("{}({}) {}", c.source, c.engagement, c.url))
                .collect();
            let _ = writeln!(s, "  +also: {}", refs.join(" | "));
        }

        for h in &it.highlights {
            let _ = writeln!(s, "  > {}", truncate_chars(h, 160));
        }
    }

    if show_detail_tip && !out.items.is_empty() {
        s.push_str("\nDetail: `last30 show <id>... [--comments] [--transcript]`\n");
    }

    s
}

pub fn render_show(items: &[Item], format: OutputFormat) -> anyhow::Result<String> {
    match format {
        OutputFormat::Json => Ok(serde_json::to_string_pretty(items)?),
        OutputFormat::Ndjson => {
            let mut buf = String::new();
            for it in items {
                buf.push_str(&serde_json::to_string(it)?);
                buf.push('\n');
            }
            Ok(buf)
        }
        OutputFormat::Compact => {
            let mut s = String::new();
            for it in items {
                let date = it
                    .published_ts
                    .map(ts_to_date)
                    .or_else(|| it.published_at.clone())
                    .unwrap_or_else(|| "?".to_string());
                let eng = it.engagement.compact_label(it.source);
                let _ = writeln!(
                    s,
                    "## [{}] [{}] {}",
                    it.item_id,
                    it.source,
                    it.title.as_deref().unwrap_or("(post)")
                );
                let _ = writeln!(s, "author: @{} | date: {} | {}", it.author, date, eng);
                let _ = writeln!(s, "url: {}", it.url);
                if let Some(link) = &it.link {
                    let _ = writeln!(s, "link: {link}");
                }
                if !it.also_on.is_empty() {
                    let refs: Vec<String> = it
                        .also_on
                        .iter()
                        .map(|c| format!("{}({}) {}", c.source, c.engagement, c.url))
                        .collect();
                    let _ = writeln!(s, "also_on: {}", refs.join(" | "));
                }
                if !it.text.is_empty() {
                    let _ = writeln!(s, "\n{}", it.text);
                }
                if !it.highlights.is_empty() {
                    s.push_str("\n### Highlights\n");
                    for h in &it.highlights {
                        let _ = writeln!(s, "- {h}");
                    }
                }
                s.push('\n');
            }
            Ok(s)
        }
    }
}
