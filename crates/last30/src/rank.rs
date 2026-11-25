use crate::model::{ClusterRef, Item, Source, SourceBatch, SourceReport, SourceState, short_hash_id};
use std::collections::{HashMap, HashSet};
use url::Url;

const FUTURE_SKEW_SECS: i64 = 300;

pub struct RankOptions<'a> {
    pub query: &'a str,
    pub days: u32,
    pub now_ts: i64,
    pub cutoff_ts: i64,
    pub max_per_source: usize,
    pub max_items: usize,
}

pub struct RankOutput {
    pub reports: Vec<SourceReport>,
    pub items: Vec<Item>,
    /// All kept primary items plus any absorbed cluster members so `last30 show <also_on.item_id>` always resolves.
    pub store_items: Vec<Item>,
}

pub fn merge_and_rank(batches: Vec<SourceBatch>, opts: &RankOptions<'_>) -> RankOutput {
    let mut reports: Vec<SourceReport> = Vec::with_capacity(batches.len());
    let mut healthy_sources: HashSet<Source> = HashSet::new();
    let mut raw_items: Vec<Item> = Vec::new();

    for mut batch in batches {
        apply_quality_gate(&mut batch);
        if batch.report.status == SourceState::Ok {
            healthy_sources.insert(batch.report.source);
        }
        reports.push(batch.report);
        raw_items.extend(batch.items);
    }

    // 1. Assign deterministic hash IDs and filter by [cutoff_ts, now_ts + FUTURE_SKEW_SECS].
    for it in &mut raw_items {
        let canon = canonicalize_url(&it.url);
        it.item_id = short_hash_id(&canon);
    }
    raw_items.retain(|it| match it.published_ts {
        Some(ts) => ts >= opts.cutoff_ts && ts <= opts.now_ts + FUTURE_SKEW_SECS,
        None => true,
    });

    // 2. Compute per-source max log engagement for fair cross-platform normalization.
    let mut max_log_eng: HashMap<Source, f64> = HashMap::new();
    for it in &raw_items {
        let v = (1.0 + it.engagement.weighted(it.source)).ln();
        let entry = max_log_eng.entry(it.source).or_insert(1.0);
        if v > *entry {
            *entry = v;
        }
    }

    let query_terms: Vec<String> = opts
        .query
        .split_whitespace()
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_ascii_lowercase())
        .filter(|w| w.len() >= 2)
        .collect();
    let query_phrase = opts.query.trim().to_ascii_lowercase();
    let decay_days = (opts.days.max(1) as f64) * 0.65;

    for it in &mut raw_items {
        let log_e = (1.0 + it.engagement.weighted(it.source)).ln();
        let norm_eng = (log_e / max_log_eng.get(&it.source).copied().unwrap_or(1.0).max(1.0))
            .clamp(0.0, 1.0);

        let recency = match it.published_ts {
            Some(ts) => {
                let age_days = ((opts.now_ts - ts).max(0) as f64) / 86_400.0;
                0.35 + 0.65 * (-age_days / decay_days).exp()
            }
            None => 0.35,
        };

        let (relevance, matched_any) =
            query_relevance(&query_terms, &query_phrase, it.title.as_deref(), &it.text);
        let mut score = 0.50 * norm_eng + 0.28 * recency + 0.22 * relevance;
        if query_terms.len() >= 2 && !matched_any {
            score *= 0.35;
        }
        it.score = (score * 100.0).round() / 100.0;
    }

    // 3. Sort descending by score (tie-break by recency).
    raw_items.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| b.published_ts.cmp(&a.published_ts))
    });

    // 4. Cross-platform external-link join clustering (retaining secondary items for promotion/store).
    struct Cluster {
        primary: Item,
        members: Vec<Item>,
    }
    let mut clusters: Vec<Cluster> = Vec::with_capacity(raw_items.len());
    let mut link_to_idx: HashMap<String, usize> = HashMap::new();

    for it in raw_items {
        let cluster_key = it.link.as_deref().and_then(canonical_external_link);
        if let Some(key) = cluster_key
            && let Some(&primary_idx) = link_to_idx.get(&key)
            && clusters[primary_idx].primary.source != it.source
        {
            let already_has_source = clusters[primary_idx]
                .primary
                .also_on
                .iter()
                .any(|c| c.source == it.source);
            if !already_has_source {
                clusters[primary_idx].primary.also_on.push(ClusterRef {
                    source: it.source,
                    item_id: it.item_id.clone(),
                    url: it.url.clone(),
                    engagement: it.engagement.compact_label(it.source),
                });
                clusters[primary_idx].primary.score =
                    ((clusters[primary_idx].primary.score + 0.15) * 100.0).round() / 100.0;
                clusters[primary_idx].members.push(it);
                continue;
            }
        }
        let idx = clusters.len();
        if let Some(key) = it.link.as_deref().and_then(canonical_external_link) {
            link_to_idx.entry(key).or_insert(idx);
        }
        clusters.push(Cluster {
            primary: it,
            members: Vec::new(),
        });
    }

    clusters.sort_by(|a, b| {
        b.primary
            .score
            .total_cmp(&a.primary.score)
            .then_with(|| b.primary.published_ts.cmp(&a.primary.published_ts))
    });

    // 5. Deduplicate + guarantee per-source minimum quota ONLY for `SourceState::Ok` sources
    //    + promote secondary cluster members when a primary is dropped by `max_per_source`.
    let active_healthy: HashSet<Source> = clusters
        .iter()
        .map(|c| c.primary.source)
        .filter(|s| healthy_sources.contains(s))
        .collect();
    let min_quota = if opts.max_items >= active_healthy.len().saturating_mul(2).max(1) {
        2.min(opts.max_per_source)
    } else {
        1.min(opts.max_per_source)
    };

    let mut seen_urls: HashSet<String> = HashSet::new();
    let mut per_source_count: HashMap<Source, usize> = HashMap::new();
    let mut kept_items: Vec<Item> = Vec::with_capacity(opts.max_items);
    let mut store_items: Vec<Item> = Vec::with_capacity(opts.max_items * 2);
    let mut deferred: Vec<Cluster> = Vec::new();

    // Pass A: satisfy minimum quota for healthy (`SourceState::Ok`) sources first
    for cl in clusters {
        let src = cl.primary.source;
        let cnt = per_source_count.get(&src).copied().unwrap_or(0);
        if healthy_sources.contains(&src) && cnt < min_quota && kept_items.len() < opts.max_items {
            let canon = canonicalize_url(&cl.primary.url);
            if seen_urls.insert(canon) {
                *per_source_count.entry(src).or_insert(0) += 1;
                store_items.push(cl.primary.clone());
                store_items.extend(cl.members);
                kept_items.push(cl.primary);
                continue;
            }
        }
        deferred.push(cl);
    }

    // Pass B: fill remaining slots in score order; if a cluster's primary hits `max_per_source`,
    // promote its absorbed secondary members back into the candidate pool!
    let mut promoted: Vec<Item> = Vec::new();
    for cl in deferred {
        if kept_items.len() >= opts.max_items {
            break;
        }
        let src = cl.primary.source;
        let cnt = per_source_count.get(&src).copied().unwrap_or(0);
        if cnt >= opts.max_per_source {
            promoted.extend(cl.members);
            continue;
        }
        let canon = canonicalize_url(&cl.primary.url);
        if !seen_urls.insert(canon) {
            promoted.extend(cl.members);
            continue;
        }
        *per_source_count.entry(src).or_insert(0) += 1;
        store_items.push(cl.primary.clone());
        store_items.extend(cl.members);
        kept_items.push(cl.primary);
    }

    if kept_items.len() < opts.max_items && !promoted.is_empty() {
        promoted.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| b.published_ts.cmp(&a.published_ts))
        });
        for it in promoted {
            if kept_items.len() >= opts.max_items {
                break;
            }
            let cnt = per_source_count.get(&it.source).copied().unwrap_or(0);
            if cnt >= opts.max_per_source {
                continue;
            }
            let canon = canonicalize_url(&it.url);
            if !seen_urls.insert(canon) {
                continue;
            }
            *per_source_count.entry(it.source).or_insert(0) += 1;
            store_items.push(it.clone());
            kept_items.push(it);
        }
    }

    kept_items.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| b.published_ts.cmp(&a.published_ts))
    });

    for rep in &mut reports {
        rep.kept = per_source_count.get(&rep.source).copied().unwrap_or(0);
    }
    reports.sort_by_key(|r| r.source);

    RankOutput {
        reports,
        items: kept_items,
        store_items,
    }
}

fn apply_quality_gate(batch: &mut SourceBatch) {
    if batch.report.status != SourceState::Ok || batch.items.is_empty() {
        return;
    }
    let total = batch.items.len();
    let zero_eng = batch.items.iter().filter(|i| i.engagement.is_zero()).count();
    let missing_ts = batch.items.iter().filter(|i| i.published_ts.is_none()).count();

    let mut reasons = Vec::new();
    let expect_metrics = batch.report.method != "threads-api";
    if expect_metrics && zero_eng == total {
        reasons.push(format!("metrics=0 for {zero_eng}/{total}"));
    }
    if missing_ts == total {
        reasons.push(format!("timestamp missing for {missing_ts}/{total}"));
    }
    if !reasons.is_empty() {
        batch.report.status = SourceState::Degraded;
        let reason_str = reasons.join(", ");
        batch.report.note = match batch.report.note.take() {
            Some(existing) if !existing.is_empty() => Some(format!("{reason_str}; {existing}")),
            _ => Some(reason_str),
        };
    }
}

/// Canonicalize external links for cross-platform join clustering, stripping ONLY
/// unambiguous tracking parameters (preserving meaningful query keys like `s`, `t`, `ref`).
fn canonical_external_link(raw: &str) -> Option<String> {
    let mut u = Url::parse(raw.trim()).ok()?;
    if !matches!(u.scheme(), "http" | "https") {
        return None;
    }
    let host = u.host_str()?.to_ascii_lowercase();
    if matches!(
        host.as_str(),
        "x.com"
            | "www.x.com"
            | "twitter.com"
            | "www.twitter.com"
            | "t.co"
            | "reddit.com"
            | "www.reddit.com"
            | "old.reddit.com"
            | "redd.it"
            | "bsky.app"
            | "threads.com"
            | "www.threads.com"
            | "threads.net"
            | "www.threads.net"
            | "news.ycombinator.com"
    ) {
        return None;
    }
    let _ = u.set_host(Some(&host));
    let keep_pairs: Vec<(String, String)> = u
        .query_pairs()
        .filter(|(k, _)| {
            let kl = k.to_ascii_lowercase();
            !kl.starts_with("utm_")
                && !matches!(kl.as_str(), "fbclid" | "gclid" | "mc_cid" | "mc_eid")
        })
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if keep_pairs.is_empty() {
        u.set_query(None);
    } else {
        let mut ser = u.query_pairs_mut();
        ser.clear();
        for (k, v) in keep_pairs {
            ser.append_pair(&k, &v);
        }
    }
    u.set_fragment(None);
    let mut s = u.to_string();
    if s.ends_with('/') {
        s.pop();
    }
    Some(s)
}

fn query_relevance(terms: &[String], phrase: &str, title: Option<&str>, text: &str) -> (f64, bool) {
    if terms.is_empty() {
        return (0.5, true);
    }
    let hay_title = title.unwrap_or("").to_ascii_lowercase();
    let hay_text = text.to_ascii_lowercase();
    let mut matched = 0.0;
    let mut any = false;
    for t in terms {
        if hay_title.contains(t) {
            matched += 1.0;
            any = true;
        } else if hay_text.contains(t) {
            matched += 0.7;
            any = true;
        }
    }
    let mut ratio = (matched / terms.len() as f64).clamp(0.0, 1.0);
    if terms.len() >= 2 && (hay_title.contains(phrase) || hay_text.contains(phrase)) {
        ratio = (ratio + 0.25).min(1.0);
    }
    (ratio, any)
}

pub fn canonicalize_url(raw: &str) -> String {
    let Ok(mut u) = Url::parse(raw.trim()) else {
        return raw.trim().to_ascii_lowercase();
    };
    if let Some(host) = u.host_str().map(|h| h.to_ascii_lowercase()) {
        let mapped = match host.as_str() {
            "twitter.com" | "www.twitter.com" | "mobile.twitter.com" | "www.x.com" | "mobile.x.com" => {
                "x.com"
            }
            "threads.net" | "www.threads.net" | "threads.com" => "www.threads.com",
            "old.reddit.com" | "np.reddit.com" | "reddit.com" => "www.reddit.com",
            "m.youtube.com" => "www.youtube.com",
            other => other,
        };
        let _ = u.set_host(Some(mapped));
    }
    let is_social = u
        .host_str()
        .map(|h| matches!(h, "x.com" | "www.threads.com" | "www.reddit.com" | "www.youtube.com"))
        .unwrap_or(false);
    let keep_pairs: Vec<(String, String)> = u
        .query_pairs()
        .filter(|(k, _)| {
            let kl = k.to_ascii_lowercase();
            let tracking = kl.starts_with("utm_") || matches!(kl.as_str(), "fbclid" | "gclid");
            let social_noise = is_social && matches!(kl.as_str(), "ref" | "s" | "t" | "si");
            !tracking && !social_noise
        })
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if keep_pairs.is_empty() {
        u.set_query(None);
    } else {
        let mut ser = u.query_pairs_mut();
        ser.clear();
        for (k, v) in keep_pairs {
            ser.append_pair(&k, &v);
        }
    }
    u.set_fragment(None);
    let mut s = u.to_string();
    if s.ends_with('/') {
        s.pop();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Engagement;

    fn mk_item(source: Source, id: &str, url: &str, ts: i64, likes: u64) -> Item {
        Item {
            item_id: String::new(),
            source,
            id: id.into(),
            title: Some(format!("Rust {id}")),
            text: "rust programming".into(),
            url: url.into(),
            link: None,
            author: "tester".into(),
            community: None,
            published_at: None,
            published_ts: Some(ts),
            engagement: Engagement { likes, comments: 5, ..Default::default() },
            score: 0.0,
            highlights: vec![],
            also_on: vec![],
        }
    }

    fn mk_batch(source: Source, items: Vec<Item>) -> SourceBatch {
        let n = items.len();
        SourceBatch {
            report: SourceReport {
                source,
                status: SourceState::Ok,
                method: "test".into(),
                fetched: n,
                kept: n,
                elapsed_ms: 10,
                note: None,
            },
            items,
        }
    }

    #[test]
    fn canonicalizes_social_vs_external_urls() {
        assert_eq!(
            canonicalize_url("https://twitter.com/alice/status/123?s=20&t=abc"),
            "https://x.com/alice/status/123"
        );
        assert_eq!(
            canonicalize_url("https://threads.net/@bob/post/XYZ/?utm_source=ig"),
            "https://www.threads.com/@bob/post/XYZ"
        );
        // External links preserve meaningful `s=` query param while stripping `utm_*`
        assert_eq!(
            canonical_external_link("https://example.com/search?s=rust&utm_source=hn").as_deref(),
            Some("https://example.com/search?s=rust")
        );
        assert_ne!(
            canonical_external_link("https://example.com/search?s=rust"),
            canonical_external_link("https://example.com/search?s=python")
        );
    }

    #[test]
    fn rejects_old_and_future_timestamps() {
        let now = 1_800_000_000;
        let cutoff = now - 30 * 86_400;
        let batch = mk_batch(
            Source::Hn,
            vec![
                mk_item(Source::Hn, "fresh", "https://news.ycombinator.com/item?id=1", now - 86_400, 100),
                mk_item(Source::Hn, "old", "https://news.ycombinator.com/item?id=2", cutoff - 10, 999),
                mk_item(Source::Hn, "future", "https://news.ycombinator.com/item?id=3", now + 86_400 * 365, 999),
            ],
        );
        let out = merge_and_rank(
            vec![batch],
            &RankOptions {
                query: "rust",
                days: 30,
                now_ts: now,
                cutoff_ts: cutoff,
                max_per_source: 5,
                max_items: 10,
            },
        );
        assert_eq!(out.items.len(), 1);
        assert_eq!(out.items[0].id, "fresh");
    }

    #[test]
    fn promotes_cluster_member_when_primary_is_capped() {
        let now = 1_800_000_000;
        let cutoff = now - 30 * 86_400;
        let mut x1 = mk_item(Source::X, "x1", "https://x.com/a/status/1", now - 100, 900);
        x1.link = None;
        let mut x2 = mk_item(Source::X, "x2", "https://x.com/a/status/2", now - 120, 400);
        x2.link = Some("https://blog.example.org/post".into());
        let mut t1 = mk_item(Source::Threads, "t1", "https://www.threads.com/@b/post/1", now - 150, 50);
        t1.link = Some("https://blog.example.org/post".into());

        let out = merge_and_rank(
            vec![mk_batch(Source::X, vec![x1, x2]), mk_batch(Source::Threads, vec![t1])],
            &RankOptions {
                query: "rust",
                days: 30,
                now_ts: now,
                cutoff_ts: cutoff,
                max_per_source: 1,
                max_items: 5,
            },
        );
        assert_eq!(out.items.len(), 2);
        assert!(out.items.iter().any(|i| i.source == Source::Threads));
    }

    #[test]
    fn degraded_source_does_not_steal_healthy_quota() {
        let now = 1_800_000_000;
        let cutoff = now - 30 * 86_400;
        let x1 = mk_item(Source::X, "x1", "https://x.com/a/status/1", now - 100, 500);
        let x2 = mk_item(Source::X, "x2", "https://x.com/a/status/2", now - 120, 400);
        let mut t1 = mk_item(Source::Threads, "t1", "https://www.threads.com/@b/post/1", now - 150, 0);
        t1.engagement.comments = 0;

        let out = merge_and_rank(
            vec![mk_batch(Source::X, vec![x1, x2]), mk_batch(Source::Threads, vec![t1])],
            &RankOptions {
                query: "rust",
                days: 30,
                now_ts: now,
                cutoff_ts: cutoff,
                max_per_source: 2,
                max_items: 2,
            },
        );
        assert_eq!(out.items.len(), 2);
        assert!(out.items.iter().all(|i| i.source == Source::X));
        let t_rep = out.reports.iter().find(|r| r.source == Source::Threads).unwrap();
        assert_eq!(t_rep.status, SourceState::Degraded);
    }

    #[test]
    fn clusters_cross_platform_and_stores_all_members() {
        let now = 1_800_000_000;
        let cutoff = now - 30 * 86_400;
        let mut hn = mk_item(Source::Hn, "1", "https://news.ycombinator.com/item?id=1", now - 100, 200);
        hn.link = Some("https://blog.rust-lang.org/post/?utm_source=hn".into());
        let mut x = mk_item(Source::X, "2", "https://x.com/alice/status/2", now - 200, 100);
        x.link = Some("https://blog.rust-lang.org/post".into());

        let out = merge_and_rank(
            vec![mk_batch(Source::Hn, vec![hn]), mk_batch(Source::X, vec![x])],
            &RankOptions {
                query: "rust",
                days: 30,
                now_ts: now,
                cutoff_ts: cutoff,
                max_per_source: 5,
                max_items: 10,
            },
        );
        assert_eq!(out.items.len(), 1);
        assert_eq!(out.items[0].also_on.len(), 1);
        assert_eq!(out.store_items.len(), 2);
    }
}
