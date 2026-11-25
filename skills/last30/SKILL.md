---
name: last30
description: Collect and synthesize the last 30 days of community sentiment and discussions across Hacker News, GitHub, Bluesky, Reddit, YouTube, X, and Threads with the `last30` Rust CLI. Use when asked for recent community reactions, trends, or developer/user opinions ("최근 반응 찾아줘", "커뮤니티 여론 조사", "last30", "요즘 평가 어때"), or when fixing broken DOM/selectors in `last30`.
---

# last30

`last30 --help`, `last30 search --help`, `last30 show --help`, and `last30 doctor` are the reference for flags, source backends, and live script paths.

## Research workflow

1. Run one compact search first:

   ```bash
   last30 search "<query>" --days 30
   ```

   This runs HN, GitHub (`is:public`), Bluesky, and YouTube in parallel over HTTP while collecting Reddit, X, and Threads together in one `ego-browser` pass, then prints a token-minimal ranked index with 8-char item IDs (`[a1b2c3d4]`) and external-link clusters (`+also:`). Add `--no-browser` for an HTTP-only pass or `--sources <list>` to narrow platforms. Done when stdout lists `## Sources` and `## Items`.

2. Check `## Sources` before synthesizing:
   - `login_required`: report which site needs sign-in. Re-run only that source with `--sources x --handoff` (or `threads`) if the user wants to sign in.
   - `degraded`, `error`, or `skipped`: keep healthy sources, report the gap honestly, and note any `dump=...` path printed in `## Sources`.

3. Pull deeper evidence only for items that actually need it:

   ```bash
   last30 show <id>... --comments --transcript
   ```

   `show` reads full text from the local run store (`~/.cache/last30/store/`) and fetches HN/Reddit comments or YouTube transcripts via `ego-browser` on demand. Pass `--x-json <file>` or `--threads-json <file>` on `search` to merge pre-captured browser exports.

4. Write the grounded brief from the returned items: lead with consensus and notable dissent, cite every claim with its URL from `## Items`, and close with a one-line source coverage summary (date window + any degraded/skipped/blocked sources). Done when every claim maps to a returned URL.

## Fix broken DOM or selectors

Browser collectors (Reddit, X, Threads, YouTube transcripts) live in a single declarative `ego-collect.js` loaded live at runtime—DOM/selector fixes take effect immediately without rebuilding Rust.

1. Find the active live script path and check health:

   ```bash
   last30 doctor --browser
   ```

   Edit the exact `browser script:` path printed by `last30 doctor` (never a stale plugin cache copy).
2. Inspect any failure dump at the `dump=...` path from `## Sources` (contains final URL, 2 candidate cards `outerHTML`, `data-testid`/custom-tag histograms, and network paths), or run:

   ```bash
   last30 search "<query>" --sources <reddit|x|threads> --max-items 3 --debug-browser
   ```

3. Update the matching `SPECS.<source>` entry in `ego-collect.js`, run `node --test /Users/hj/study/hj-agent-tools/tests/last30-extractors.test.mjs`, and re-run step 2. Done when `## Sources` reports `ok` (not `degraded`) with non-zero kept items.
4. For HTTP collectors (HN, GitHub, Bluesky, YouTube web/API), edit `crates/last30/src/sources/<source>.rs` in `/Users/hj/study/hj-agent-tools` and rebuild with `just build`.

## Failures

- `command not found`: report it. Install with `just install` in `/Users/hj/study/hj-agent-tools`.
- Credentials (all optional) live in `~/.config/last30/.env`. Run `last30 doctor` to inspect availability without reading that file.
