import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(__dirname, "../skills/last30/scripts/ego-collect.js");

async function loadExtractors() {
  const src = await readFile(scriptPath, "utf8");
  // Load without defining CONFIG so only the pure helpers initialize on globalThis.__last30Extractors
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction(src)();
  return globalThis.__last30Extractors;
}

test("truncateCodePoints never splits UTF-16 surrogate pairs", async () => {
  const { truncateCodePoints } = await loadExtractors();
  const text = "a".repeat(3999) + "😀" + "z";
  const out = truncateCodePoints(text, 4000);
  assert.equal(Array.from(out).length, 4000);
  assert.ok(out.endsWith("😀"));
  // Valid UTF-8 round-trip via JSON (no lone surrogate)
  assert.equal(JSON.parse(JSON.stringify(out)), out);
});

test("isAllowedCaptionUrl allows only HTTPS youtube/googlevideo hosts", async () => {
  const { isAllowedCaptionUrl } = await loadExtractors();
  assert.equal(isAllowedCaptionUrl("https://www.youtube.com/api/timedtext?v=abc"), true);
  assert.equal(isAllowedCaptionUrl("https://rr1---sn.googlevideo.com/timedtext"), true);
  assert.equal(isAllowedCaptionUrl("http://www.youtube.com/api/timedtext"), false);
  assert.equal(isAllowedCaptionUrl("https://evil.example.com/api/timedtext"), false);
  assert.equal(isAllowedCaptionUrl("https://youtube.com.evil.io/api/timedtext"), false);
});

test("collectXTweetsFromGraphQL extracts metrics and external expanded_url", async () => {
  const { collectXTweetsFromGraphQL } = await loadExtractors();
  const fixture = {
    data: {
      instructions: [
        {
          tweet_results: {
            result: {
              rest_id: "1234567890",
              views: { count: "42000" },
              core: { user_results: { result: { legacy: { screen_name: "alice" } } } },
              legacy: {
                full_text: "Check out this Rust release https://t.co/abc",
                created_at: "Wed Nov 25 12:00:00 +0000 2026",
                favorite_count: 150,
                retweet_count: 20,
                quote_count: 5,
                reply_count: 12,
                entities: {
                  urls: [{ expanded_url: "https://blog.rust-lang.org/2026/11/12/Rust-1.100.0/" }],
                },
              },
            },
          },
        },
      ],
    },
  };
  const map = new Map();
  collectXTweetsFromGraphQL(fixture, map);
  assert.equal(map.size, 1);
  const item = [...map.values()][0];
  assert.equal(item.url, "https://x.com/alice/status/1234567890");
  assert.equal(item.link, "https://blog.rust-lang.org/2026/11/12/Rust-1.100.0/");
  assert.equal(item.likes, 150);
  assert.equal(item.reposts, 25);
  assert.equal(item.views, 42000);
});

test("collectThreadsFromGraphQL parses SSR JSON metrics and taken_at", async () => {
  const { collectThreadsFromGraphQL } = await loadExtractors();
  const fixture = {
    require: [
      {
        thread_items: [
          {
            post: {
              pk: "999",
              code: "Df7q0CiEgkk",
              user: { username: "dev_user" },
              caption: { text: "Rust 1.100 compile times feel much better!" },
              taken_at: 1795000000,
              like_count: 88,
              text_post_app_info: {
                direct_reply_count: 14,
                repost_count: 6,
                quote_count: 2,
                link_preview_attachment: { url: "https://blog.rust-lang.org/2026/11/12/Rust-1.100.0/" },
              },
            },
          },
        ],
      },
    ],
  };
  const map = new Map();
  collectThreadsFromGraphQL(fixture, map);
  assert.equal(map.size, 1);
  const item = [...map.values()][0];
  assert.equal(item.url, "https://www.threads.com/@dev_user/post/Df7q0CiEgkk");
  assert.equal(item.likes, 88);
  assert.equal(item.comments, 14);
  assert.equal(item.reposts, 8);
  assert.equal(item.published_ts, 1795000000);
  assert.equal(item.link, "https://blog.rust-lang.org/2026/11/12/Rust-1.100.0/");
});

test("collectXTweetsFromGraphQL merges Note Tweet URLs when legacy urls is empty and preserves full text", async () => {
  const { collectXTweetsFromGraphQL, isExternalNonXUrl } = await loadExtractors();
  assert.equal(isExternalNonXUrl("https://box.com/shared/123"), true);
  assert.equal(isExternalNonXUrl("https://x.com/user/status/1"), false);
  const longText = "x".repeat(1500);
  const fixture = {
    tweet_results: {
      result: {
        rest_id: "777",
        core: { user_results: { result: { legacy: { screen_name: "note_author" } } } },
        note_tweet: {
          note_tweet_results: {
            result: {
              text: longText,
              entity_set: { urls: [{ expanded_url: "https://box.com/docs/spec" }] },
            },
          },
        },
        legacy: {
          full_text: "truncated...",
          created_at: "Wed Nov 25 12:00:00 +0000 2026",
          favorite_count: 10,
          entities: { urls: [] },
        },
      },
    },
  };
  const map = new Map();
  collectXTweetsFromGraphQL(fixture, map);
  const item = [...map.values()][0];
  assert.equal(item.text.length, 1500);
  assert.equal(item.link, "https://box.com/docs/spec");
});

test("selectRecentItems filters cutoff and sorts newest-first before slicing limit", async () => {
  const { selectRecentItems } = await loadExtractors();
  const now = 1_800_000_000;
  const cutoff = now - 30 * 86_400;
  const items = [
    { id: "old", published_ts: cutoff - 1000 },
    { id: "fresh", published_ts: now - 3600 },
    { id: "mid", published_ts: now - 5 * 86_400 },
  ];
  const out = selectRecentItems(items, cutoff, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "fresh");
});
