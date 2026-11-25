// Declarative ego-browser collector (schema v1) for Reddit, X, Threads, and YouTube transcripts.
// Loaded live at runtime by `last30` (edit this file for instant DOM/selector hotfixes—no Rust rebuild).
// When run by `last30`, `const CONFIG = ...;` is prepended. When loaded by `node --test`, pure helpers
// are exposed on `globalThis.__last30Extractors`.

const SCHEMA_VERSION = 1;
const MAX_STORED_TEXT = 16000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function truncateCodePoints(str, max) {
  if (typeof str !== "string" || !str) return "";
  if (str.length <= max) return str;
  return Array.from(str).slice(0, max).join("");
}

function safeNum(v) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  if (typeof v === "string") {
    const cleaned = v.replace(/,/g, "").trim().toLowerCase();
    const m = cleaned.match(/^([\d.]+)\s*([kmb])?$/);
    if (m) {
      const n = parseFloat(m[1]);
      const mult = m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : m[2] === "b" ? 1e9 : 1;
      return Math.floor(n * mult);
    }
  }
  return 0;
}

function isExternalNonXUrl(raw) {
  if (typeof raw !== "string" || !raw) return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return (
      h !== "x.com" &&
      !h.endsWith(".x.com") &&
      h !== "twitter.com" &&
      !h.endsWith(".twitter.com") &&
      h !== "t.co"
    );
  } catch {
    return false;
  }
}

function isAllowedCaptionUrl(raw) {
  if (typeof raw !== "string" || !raw) return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return (
      h === "youtube.com" ||
      h.endsWith(".youtube.com") ||
      h === "googlevideo.com" ||
      h.endsWith(".googlevideo.com")
    );
  } catch {
    return false;
  }
}

function collectXTweetsFromGraphQL(root, outMap) {
  const queue = [root];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    if (!cur || typeof cur !== "object") continue;
    if (Array.isArray(cur)) {
      for (const x of cur) queue.push(x);
      continue;
    }
    const candidate =
      cur.tweet_results?.result || cur.tweet || (cur.legacy && cur.rest_id ? cur : null);
    if (candidate && typeof candidate === "object") {
      const node = candidate.tweet || candidate;
      const legacy = node.legacy;
      const restId = node.rest_id || legacy?.id_str;
      if (legacy && restId) {
        const text =
          node.note_tweet?.note_tweet_results?.result?.text ||
          legacy.full_text ||
          "";
        const screenName =
          node.core?.user_results?.result?.legacy?.screen_name ||
          node.core?.user_results?.result?.core?.screen_name ||
          "i";
        const url = `https://x.com/${screenName}/status/${restId}`;
        // Merge both note_tweet and legacy URL entities so an empty legacy array does not hide Note URLs
        const noteUrls = node.note_tweet?.note_tweet_results?.result?.entity_set?.urls || [];
        const legacyUrls = legacy.entities?.urls || [];
        const urls = [...noteUrls, ...legacyUrls];
        const extLink = urls.map((u) => u?.expanded_url).find(isExternalNonXUrl) || null;

        if (text.trim() && !outMap.has(url)) {
          outMap.set(url, {
            id: String(restId),
            url,
            link: extLink,
            author: screenName,
            community: "X",
            text: truncateCodePoints(text.trim(), MAX_STORED_TEXT),
            published_at: legacy.created_at || null,
            likes: safeNum(legacy.favorite_count),
            reposts: safeNum(legacy.retweet_count) + safeNum(legacy.quote_count),
            comments: safeNum(legacy.reply_count),
            views: safeNum(node.views?.count),
          });
        }
      }
    }
    for (const v of Object.values(cur)) {
      if (v && typeof v === "object") queue.push(v);
    }
  }
}

function collectThreadsFromGraphQL(root, outMap) {
  // BFS (FIFO) preserves server ordering instead of reversing arrays
  const queue = [root];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    if (!cur || typeof cur !== "object") continue;
    if (Array.isArray(cur)) {
      for (const x of cur) queue.push(x);
      continue;
    }
    const post = cur.post || (cur.code && cur.user && (cur.caption || cur.text_post_app_info) ? cur : null);
    if (post && typeof post === "object" && post.code && post.user?.username) {
      const text =
        post.caption?.text ||
        post.text_post_app_info?.text_fragments?.fragments
          ?.map((f) => f.plaintext || "")
          .join("") ||
        "";
      const username = post.user.username;
      const url = `https://www.threads.com/@${username}/post/${post.code}`;
      const extLink = post.text_post_app_info?.link_preview_attachment?.url || null;

      if (text.trim() && !outMap.has(url)) {
        const takenAt = typeof post.taken_at === "number" ? post.taken_at : null;
        outMap.set(url, {
          id: String(post.pk || post.id || post.code),
          url,
          link: typeof extLink === "string" && /^https?:\/\//.test(extLink) ? extLink : null,
          author: username,
          community: "Threads",
          text: truncateCodePoints(text.trim(), MAX_STORED_TEXT),
          published_ts: takenAt,
          published_at: takenAt ? new Date(takenAt * 1000).toISOString() : null,
          likes: safeNum(post.like_count),
          comments: safeNum(post.text_post_app_info?.direct_reply_count),
          reposts:
            safeNum(post.text_post_app_info?.repost_count) +
            safeNum(post.text_post_app_info?.quote_count),
          views: 0,
        });
      }
    }
    for (const v of Object.values(cur)) {
      if (v && typeof v === "object") queue.push(v);
    }
  }
}

function selectRecentItems(items, cutoffTs, limit) {
  const parsed = items.map((it) => {
    let ts = typeof it.published_ts === "number" ? it.published_ts : null;
    if (ts === null && typeof it.published_at === "string") {
      const ms = Date.parse(it.published_at);
      if (Number.isFinite(ms)) ts = Math.floor(ms / 1000);
    }
    return { it, ts };
  });
  const recent =
    typeof cutoffTs === "number" && cutoffTs > 0
      ? parsed.filter((x) => x.ts === null || x.ts >= cutoffTs)
      : parsed;
  recent.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  return recent.slice(0, limit).map((x) => x.it);
}

globalThis.__last30Extractors = {
  SCHEMA_VERSION,
  truncateCodePoints,
  safeNum,
  isExternalNonXUrl,
  isAllowedCaptionUrl,
  collectXTweetsFromGraphQL,
  collectThreadsFromGraphQL,
  selectRecentItems,
};

async function writeFailureDump(fs, pathMod, dumpsDir, runId, source, page, netPaths, reason) {
  if (!dumpsDir) return null;
  try {
    const snap = await page
      .evaluate((src) => {
        const cardSel =
          src === "reddit"
            ? '[data-testid="search-post-unit"], article'
            : src === "x"
              ? 'article[data-testid="tweet"]'
              : 'a[href*="/post/"]';
        const cards = [...document.querySelectorAll(cardSel)]
          .slice(0, 2)
          .map((el) => {
            const box = src === "threads" ? el.parentElement?.parentElement || el : el;
            return Array.from(box.outerHTML || "").slice(0, 10000).join("");
          });
        const testIds = {};
        for (const el of document.querySelectorAll("[data-testid]")) {
          const k = el.getAttribute("data-testid");
          if (k) testIds[k] = (testIds[k] || 0) + 1;
        }
        const customTags = {};
        for (const el of document.querySelectorAll("*")) {
          const tag = el.tagName.toLowerCase();
          if (tag.includes("-")) customTags[tag] = (customTags[tag] || 0) + 1;
        }
        const topEntries = (obj) =>
          Object.entries(obj)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20);
        return {
          finalUrl: location.href,
          title: document.title,
          cards,
          topTestIds: topEntries(testIds),
          topCustomTags: topEntries(customTags),
        };
      }, source)
      .catch((e) => ({ evalError: String(e?.message || e) }));

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = pathMod.join(dumpsDir, `${source}-${stamp}-${runId}`);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const filePath = pathMod.join(dir, "dump.json");
    const payload = {
      source,
      reason,
      capturedAt: new Date().toISOString(),
      networkPaths: Object.entries(netPaths || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20),
      ...snap,
    };
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    return filePath;
  } catch {
    return null;
  }
}

async function checkpointWrite(fs, outPath, payloadObj) {
  const tmp = `${outPath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payloadObj), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, outPath);
}

// Declarative per-source specs: hotfixing a site is editing one spec object below.
const SPECS = {
  reddit: {
    url: (cfg) =>
      `https://www.reddit.com/search/?q=${encodeURIComponent(cfg.query)}&sort=top&t=${encodeURIComponent(cfg.redditBucket || "month")}`,
    needsNetwork: false,
    loginPattern: /\/login/i,
    async harvest(page, cfg, _netPaths, budgetMs) {
      await page
        .waitForSelector('[data-testid="search-post-unit"], a[data-testid="post-title"]', {
          timeout: Math.max(500, Math.min(3000, budgetMs)),
        })
        .catch(() => {});

      const curUrl = await page.url();
      if (this.loginPattern.test(curUrl)) {
        return { status: "login_required", method: "ego-browser", note: `login required at ${curUrl}`, items: [] };
      }

      const items = await page.evaluate((maxItems) => {
        const parseCount = (txt) => {
          if (!txt) return 0;
          const m = txt.replace(/,/g, "").trim().toLowerCase().match(/([\d.]+)\s*([kmb])?/);
          if (!m) return 0;
          const n = parseFloat(m[1]);
          const mult = m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : m[2] === "b" ? 1e9 : 1;
          return Math.floor(n * mult);
        };
        const seen = new Set();
        const out = [];
        const units = [...document.querySelectorAll('[data-testid="search-post-unit"]')];

        const extractLinkAndTitle = (card) => {
          const explicit = card.querySelector('a[data-testid="post-title"]');
          const candidates = explicit
            ? [explicit, ...card.querySelectorAll('a[href*="/comments/"]')]
            : [...card.querySelectorAll('a[href*="/comments/"]')];
          for (const a of candidates) {
            const href = a.getAttribute("href") || "";
            const m = href.match(/^(\/r\/([^/]+)\/comments\/([^/?#]+)(?:\/[^?#]*)?)/);
            if (!m) continue;
            const title = (a.innerText || a.getAttribute("aria-label") || "").trim();
            if (title.length >= 3) {
              return { match: m, title };
            }
          }
          return null;
        };

        const processCard = (card) => {
          if (!card || typeof card.querySelectorAll !== "function") return;
          const found = extractLinkAndTitle(card);
          if (!found) return;
          const { match: m, title } = found;
          const url = `https://www.reddit.com${m[1]}`;
          if (seen.has(url)) return;
          seen.add(url);

          const timeEl = card.querySelector("faceplate-timeago[ts], time[datetime]");
          const publishedAt = timeEl?.getAttribute("ts") || timeEl?.getAttribute("datetime") || null;
          const fpNums = [...card.querySelectorAll("faceplate-number[number]")].map((el) =>
            parseCount(el.getAttribute("number") || ""),
          );
          const cardText = card.innerText || "";
          const voteMatch = cardText.match(/([\d.,]+[KkMm]?)\s*(?:upvotes?|votes?)/i);
          const commMatch = cardText.match(/([\d.,]+[KkMm]?)\s*comments?/i);
          const authorMatch = cardText.match(/u\/([A-Za-z0-9_-]+)/);

          out.push({
            id: m[3],
            title,
            text: "",
            url,
            author: authorMatch ? authorMatch[1] : `r/${m[2]}`,
            community: `r/${m[2]}`,
            published_at: publishedAt,
            likes: fpNums[0] ?? (voteMatch ? parseCount(voteMatch[1]) : 0),
            comments: fpNums[1] ?? (commMatch ? parseCount(commMatch[1]) : 0),
            reposts: 0,
            views: 0,
          });
        };

        for (const unit of units) {
          if (out.length >= maxItems) break;
          processCard(unit);
        }
        if (out.length === 0) {
          for (const a of document.querySelectorAll('a[data-testid="post-title"], a[href*="/comments/"]')) {
            if (out.length >= maxItems) break;
            const card = a.closest('[data-testid="search-post-unit"], article') || a.parentElement?.parentElement;
            processCard(card);
          }
        }
        return out;
      }, cfg.limit || 15);

      return {
        status: "ok",
        method: "ego-browser(dom)",
        note: items.length === 0 ? "no Reddit posts matched" : null,
        items: (items || []).map((it) => ({
          ...it,
          title: truncateCodePoints(it.title || "", 400),
          text: truncateCodePoints(it.text || "", MAX_STORED_TEXT),
        })),
      };
    },
  },

  x: {
    url: (cfg) =>
      `https://x.com/search?q=${encodeURIComponent(`${cfg.query} since:${cfg.cutoffDate}`)}&src=typed_query&f=top`,
    needsNetwork: true,
    loginPattern: /\/(login|i\/flow\/login)/i,
    async harvest(page, cfg, netPaths, budgetMs) {
      const waitBudget = Math.max(800, Math.min(cfg.deadlineMs || 5500, budgetMs - 1500));
      const deadline = Date.now() + waitBudget;
      const searchReqIds = new Set();
      const finishedReqIds = [];

      const drainEvents = async () => {
        const events = await page.events().catch(() => []);
        for (const ev of events || []) {
          const m = ev?.method || ev?.type;
          if (m === "Network.responseReceived") {
            const url = ev?.params?.response?.url || "";
            const status = ev?.params?.response?.status || 0;
            try {
              const p = new URL(url).pathname;
              netPaths[p] = (netPaths[p] || 0) + 1;
            } catch {}
            if (status === 200 && url.includes("SearchTimeline")) {
              searchReqIds.add(ev.params.requestId);
            }
          } else if (m === "Network.loadingFinished") {
            const rid = ev?.params?.requestId;
            if (rid && searchReqIds.has(rid)) {
              finishedReqIds.push(rid);
            }
          }
        }
      };

      while (Date.now() < deadline && finishedReqIds.length === 0) {
        await drainEvents();
        if (finishedReqIds.length > 0) break;
        const curUrl = await page.url().catch(() => "");
        if (this.loginPattern.test(curUrl)) {
          return { status: "login_required", method: "ego-browser", note: `login required at ${curUrl}`, items: [] };
        }
        await sleep(150);
      }
      await drainEvents();

      const curUrl = await page.url();
      if (this.loginPattern.test(curUrl)) {
        return { status: "login_required", method: "ego-browser", note: `login required at ${curUrl}`, items: [] };
      }

      const outMap = new Map();
      let method = "ego-browser(cdp)";
      const targetIds = finishedReqIds.length > 0 ? finishedReqIds : [...searchReqIds];

      for (const requestId of targetIds.slice(0, 4)) {
        try {
          const bodyResp = await page.cdp("Network.getResponseBody", { requestId }, { timeout: 2000 });
          if (bodyResp?.body) {
            collectXTweetsFromGraphQL(JSON.parse(bodyResp.body), outMap);
          }
        } catch {}
      }

      if (outMap.size === 0) {
        method = "ego-browser(dom)";
        await page.waitForSelector('article[data-testid="tweet"]', { timeout: 2000 }).catch(() => {});
        const domItems = await page.evaluate((maxItems) => {
          const parseCount = (txt) => {
            if (!txt) return 0;
            const m = txt.replace(/,/g, "").trim().toLowerCase().match(/([\d.]+)\s*([kmb])?/);
            if (!m) return 0;
            const n = parseFloat(m[1]);
            const mult = m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : m[2] === "b" ? 1e9 : 1;
            return Math.floor(n * mult);
          };
          const out = [];
          for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
            if (out.length >= maxItems) break;
            const timeEl = art.querySelector("time[datetime]");
            const linkEl = timeEl?.closest("a") || art.querySelector('a[href*="/status/"]');
            const href = linkEl?.getAttribute("href") || "";
            const m = href.match(/^\/([^/]+)\/status\/(\d+)/);
            if (!m) continue;
            const text = art.querySelector('[data-testid="tweetText"]')?.innerText?.trim() || "";
            if (!text) continue;
            const metric = (testid) => {
              const el = art.querySelector(`[data-testid="${testid}"]`);
              return parseCount(el?.innerText || el?.getAttribute("aria-label") || "");
            };
            const viewsEl = art.querySelector('a[href*="/analytics"]');
            out.push({
              id: m[2],
              url: `https://x.com/${m[1]}/status/${m[2]}`,
              author: m[1],
              community: "X",
              text,
              published_at: timeEl?.getAttribute("datetime") || null,
              likes: metric("like"),
              reposts: metric("retweet"),
              comments: metric("reply"),
              views: parseCount(viewsEl?.innerText || ""),
            });
          }
          return out;
        }, cfg.limit || 15);

        for (const item of domItems || []) {
          item.text = truncateCodePoints(item.text || "", MAX_STORED_TEXT);
          if (!outMap.has(item.url)) outMap.set(item.url, item);
        }
      }

      const items = selectRecentItems(Array.from(outMap.values()), cfg.cutoffTs, cfg.limit || 15);
      return {
        status: "ok",
        method,
        note: items.length === 0 ? "no tweets matched or session not signed in" : null,
        items,
      };
    },
  },

  threads: {
    url: (cfg) => `https://www.threads.com/search?q=${encodeURIComponent(cfg.query)}&serp_type=default`,
    needsNetwork: false,
    loginPattern: /\/login/i,
    async harvest(page, cfg, _netPaths, budgetMs) {
      await page
        .waitForSelector('script[type="application/json"], a[href*="/post/"]', {
          timeout: Math.max(500, Math.min(3500, budgetMs)),
        })
        .catch(() => {});

      const curUrl = await page.url();
      if (this.loginPattern.test(curUrl)) {
        return { status: "login_required", method: "ego-browser", note: `login required at ${curUrl}`, items: [] };
      }

      // Single evaluate: read SSR JSON blobs + login detection; parse in Node first.
      const pageData = await page.evaluate(() => {
        const ssrBlobs = [];
        for (const sc of document.querySelectorAll('script[type="application/json"]')) {
          const txt = sc.textContent || "";
          if (txt.length > 200 && (txt.includes("thread_items") || txt.includes("text_post_app_info"))) {
            ssrBlobs.push(txt);
          }
        }
        const loginInput = Boolean(document.querySelector('input[name="username"], input[type="password"]'));
        return { ssrBlobs, loginInput };
      });

      const outMap = new Map();
      let method = "ego-browser(ssr)";

      for (const blob of pageData?.ssrBlobs || []) {
        try {
          collectThreadsFromGraphQL(JSON.parse(blob), outMap);
        } catch {}
      }

      // If SSR yielded 0 parsed posts (even if an empty thread_items blob existed), fall back to DOM
      if (outMap.size === 0) {
        method = "ego-browser(dom)";
        const domItems = await page.evaluate((maxItems) => {
          const seen = new Set();
          const out = [];
          for (const a of document.querySelectorAll('a[href*="/post/"]')) {
            if (out.length >= maxItems) break;
            const href = a.getAttribute("href") || "";
            const m = href.match(/\/@([^/]+)\/post\/([^/?#]+)/);
            if (!m) continue;
            const url = `https://www.threads.com/@${m[1]}/post/${m[2]}`;
            if (seen.has(url)) continue;
            seen.add(url);
            let box = a.parentElement;
            for (let i = 0; i < 6 && box; i++) {
              if (box.innerText && box.innerText.length > 35 && box.querySelectorAll('a[href*="/post/"]').length <= 3) {
                break;
              }
              box = box.parentElement;
            }
            const timeEl = a.querySelector("time[datetime]") || box?.querySelector("time[datetime]");
            const rawText = (box?.innerText || "")
              .split("\n")
              .map((l) => l.trim())
              .filter(
                (l) =>
                  l &&
                  l !== m[1] &&
                  !/^(Like|Reply|Repost|Share|Follow|Translate|좋아요|답글|리포스트|공유|\d+[smhdw]|[\d.,]+[KkMm]?)$/i.test(l),
              )
              .join(" ");
            if (!rawText) continue;
            out.push({
              id: m[2],
              url,
              author: m[1],
              community: "Threads",
              text: rawText,
              published_at: timeEl?.getAttribute("datetime") || null,
              likes: 0,
              reposts: 0,
              comments: 0,
              views: 0,
            });
          }
          return out;
        }, (cfg.limit || 15) * 2);

        if (pageData?.loginInput && (!domItems || domItems.length === 0)) {
          return {
            status: "login_required",
            method: "ego-browser",
            note: "Threads requires sign-in to search",
            items: [],
          };
        }
        for (const item of domItems || []) {
          item.text = truncateCodePoints(item.text || "", MAX_STORED_TEXT);
          if (!outMap.has(item.url)) outMap.set(item.url, item);
        }
      }

      // Filter by cutoffTs and sort newest-first BEFORE slicing to limit
      const items = selectRecentItems(Array.from(outMap.values()), cfg.cutoffTs, cfg.limit || 15);
      return {
        status: "ok",
        method,
        note: items.length === 0 ? "no recent Threads posts within cutoff" : null,
        items,
      };
    },
  },
};

async function fetchYoutubeTranscript(page, videoUrl, maxChars) {
  const started = Date.now();
  try {
    await page.goto(videoUrl, { timeout: 12000, waitUntil: "domcontentloaded" });
    await sleep(1000);

    const meta = await page.evaluate(() => {
      const pr = window.ytInitialPlayerResponse || null;
      const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      const title = pr?.videoDetails?.title || document.title || "";
      const author = pr?.videoDetails?.author || "";
      return {
        title,
        author,
        tracks: tracks.map((t) => ({
          lang: t.languageCode || "",
          kind: t.kind || "",
          baseUrl: t.baseUrl || "",
        })),
      };
    });

    let transcript = "";
    let lang = null;
    const tracks = meta?.tracks || [];
    if (tracks.length > 0) {
      const pref = ["ko", "en"];
      let picked = null;
      for (const code of pref) {
        picked =
          tracks.find((t) => t.lang.startsWith(code) && t.kind !== "asr") ||
          tracks.find((t) => t.lang.startsWith(code));
        if (picked) break;
      }
      picked = picked || tracks[0];
      lang = picked.lang;
      if (picked.baseUrl && isAllowedCaptionUrl(picked.baseUrl)) {
        const captionUrl = picked.baseUrl.includes("fmt=")
          ? picked.baseUrl
          : `${picked.baseUrl}&fmt=json3`;
        const resp = await page.fetch(captionUrl, { timeout: 10000 }).catch(() => null);
        if (resp?.ok && resp.body) {
          try {
            const json = JSON.parse(resp.body);
            const segs = [];
            for (const ev of json.events || []) {
              if (!Array.isArray(ev.segs)) continue;
              const line = ev.segs
                .map((s) => s.utf8 || "")
                .join("")
                .replace(/\s+/g, " ")
                .trim();
              if (line) segs.push(line);
            }
            transcript = segs.join(" ");
          } catch {}
        }
      }
    }

    if (!transcript) {
      await page
        .click('button[aria-label*="transcript" i], button[aria-label*="스크립트"]', {
          label: "open YouTube transcript",
        })
        .catch(() => {});
      await sleep(1000);
      transcript = await page
        .evaluate(() => {
          const segs = [
            ...document.querySelectorAll(
              "ytd-transcript-segment-renderer .segment-text, yt-formatted-string.segment-text",
            ),
          ];
          return segs
            .map((el) => el.textContent?.trim() || "")
            .filter(Boolean)
            .join(" ");
        })
        .catch(() => "");
    }

    return {
      url: videoUrl,
      title: truncateCodePoints(meta?.title || "", 300),
      author: truncateCodePoints(meta?.author || "", 120),
      lang,
      status: transcript ? "ok" : "unavailable",
      elapsed_ms: Date.now() - started,
      transcript: truncateCodePoints(transcript, maxChars),
    };
  } catch (err) {
    return {
      url: videoUrl,
      title: "",
      author: "",
      lang: null,
      status: "error",
      elapsed_ms: Date.now() - started,
      note: String(err?.message || err),
      transcript: "",
    };
  }
}

if (typeof CONFIG !== "undefined") {
  const fs = await import("node:fs/promises");
  const pathMod = await import("node:path");
  const cryptoMod = await import("node:crypto");

  const runId = cryptoMod.randomUUID().slice(0, 10);
  const spaceName = `last30-${runId}`;
  const runStart = Date.now();
  const hardDeadline = runStart + Math.max(8000, (CONFIG.globalDeadlineMs || 18000) - 1500);
  const task = await taskSpace(spaceName);
  let needsHandoff = false;

  try {
    if (CONFIG.mode === "transcripts") {
      const page = task.page("p1");
      const results = [];
      for (const url of CONFIG.urls || []) {
        results.push(await fetchYoutubeTranscript(page, url, CONFIG.maxChars || 4000));
      }
      await checkpointWrite(fs, CONFIG.outPath, {
        schema: SCHEMA_VERSION,
        taskSpaceId: task.spaceId,
        results,
      });
    } else {
      const order = { reddit: 0, x: 1, threads: 2 };
      const requested = [...(CONFIG.sources || [])]
        .filter((s) => Boolean(SPECS[s]))
        .sort((a, b) => (order[a] ?? 9) - (order[b] ?? 9));

      const slots = [];
      for (let i = 0; i < requested.length; i++) {
        const src = requested[i];
        const page = i === 0 ? task.page("p1") : await task.newPage();
        slots.push({ src, page, spec: SPECS[src], started: Date.now(), netPaths: {}, gotoErr: null });
      }

      // Phase 1: launch all navigations concurrently within shared deadline
      const navTimeout = Math.max(3000, Math.min(9000, hardDeadline - Date.now() - 3500));
      await Promise.all(
        slots.map(async (slot) => {
          try {
            if (slot.spec.needsNetwork) {
              await slot.page.cdp("Network.enable").catch(() => {});
            }
            await slot.page.goto(slot.spec.url(CONFIG), {
              timeout: navTimeout,
              waitUntil: "domcontentloaded",
            });
          } catch (err) {
            slot.gotoErr = String(err?.message || err);
          }
        }),
      );

      // Phase 2: 1 harvest pass per page in reddit -> x -> threads order, checkpointing after each source
      const batches = [];
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        const remaining = hardDeadline - Date.now();
        const remainingSources = slots.length - i;
        let res;
        if (slot.gotoErr) {
          res = { status: "error", method: "ego-browser", note: slot.gotoErr, items: [] };
        } else if (remaining < 400) {
          res = { status: "error", method: "ego-browser", note: "browser deadline exhausted", items: [] };
        } else {
          const sliceBudget = Math.max(800, Math.floor(remaining / remainingSources) + 1200);
          try {
            res = await slot.spec.harvest(slot.page, CONFIG, slot.netPaths, Math.min(remaining, sliceBudget));
          } catch (err) {
            res = { status: "error", method: "ego-browser", note: String(err?.message || err), items: [] };
          }
        }

        let dumpPath = null;
        const allZeroEng =
          res.items.length > 0 &&
          res.items.every((it) => !it.likes && !it.comments && !it.reposts && !it.views);
        const allMissingTs = res.items.length > 0 && res.items.every((it) => !it.published_at && !it.published_ts);
        if (res.status === "ok" && (allZeroEng || allMissingTs)) {
          res.status = "degraded";
          const why = [
            allZeroEng ? `metrics=0 for ${res.items.length}/${res.items.length}` : null,
            allMissingTs ? `timestamp missing for ${res.items.length}/${res.items.length}` : null,
          ]
            .filter(Boolean)
            .join(", ");
          res.note = res.note ? `${why}; ${res.note}` : why;
        }

        if (
          CONFIG.dumpsDir &&
          hardDeadline - Date.now() > 600 &&
          res.status !== "login_required" &&
          (res.status === "error" || res.status === "degraded" || res.items.length === 0)
        ) {
          dumpPath = await writeFailureDump(
            fs,
            pathMod,
            CONFIG.dumpsDir,
            runId,
            slot.src,
            slot.page,
            slot.netPaths,
            res.note || res.status,
          );
        }

        batches.push({
          source: slot.src,
          status: res.status,
          method: res.method,
          elapsed_ms: Date.now() - slot.started,
          note: res.note || null,
          dumpPath,
          items: res.items,
        });

        // Atomic checkpoint after each completed source so a later timeout never loses earlier successes
        await checkpointWrite(fs, CONFIG.outPath, {
          schema: SCHEMA_VERSION,
          taskSpaceId: task.spaceId,
          handedOff: false,
          batches,
        }).catch(() => {});
      }

      if (CONFIG.handoff && batches.some((b) => b.status === "login_required")) {
        needsHandoff = true;
        await task.handOff();
      }

      await checkpointWrite(fs, CONFIG.outPath, {
        schema: SCHEMA_VERSION,
        taskSpaceId: task.spaceId,
        handedOff: needsHandoff,
        batches,
      });
    }
  } finally {
    if (!needsHandoff) {
      await task.finish({ keep: [] }).catch(() => {});
    }
  }
}
