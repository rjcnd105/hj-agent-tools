#!/usr/bin/env node
// Replays realistic wheel, trackpad, touch, and click input into a Chromium page over the
// DevTools protocol, at the timing a real device produces. Node 22+, no dependencies.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const USAGE = `usage: replay.mjs <url> [options] [step...]

Steps run in order, each from where the last one left the page. After each one the page
settles, then one JSON line is printed: sent, got (events the page received), missed, ms
(gesture plus settling), read, and for touch steps readAtLift (--read as the finger lifts).
  trackpad:<dir>         trackpad flick with the macOS inertia tail (~80 wheel events, 16 ms apart)
  mouse:<dir>            one short mouse-wheel roll (measured on Mac Chrome: 4 px, then 30.7 px)
  mouse-fast:<dir>       one quick roll (4, 146.6, 165.4 px, 30 ms apart)
  mouse-hold:<dir>[:<n>] steady rolling: 4 px, then n x 40 px every 33 ms (default n = 40)
  wheel:<file.json>      recorded wheel samples [{dt, dx, dy}], replayed at their own timing
  swipe:<dx>,<dy>        finger moves dx,dy px in 192 ms and lifts at speed (fling)
  drag:<dx>,<dy>         same move, finger rests 150 ms before lifting (no fling)
  tap                    finger down and up at the target
  click                  mouse move, press, release at the target
  pause:<ms>             wait

<dir> is the scroll direction: right means deltaX > 0, which shows what lies to the right.
swipe and drag take finger travel, so swipe:-300,0 also shows what lies to the right.

Options:
  --at <css>        target element, scrolled to the viewport center at start; steps land on
                    its center (default: viewport center)
  --read <js>       expression printed after each step; awaited when it returns a promise.
                    For statements, wrap them: '(() => { ...; return {...}; })()'
  --wait <js>       after each step, poll until truthy instead of waiting for 500 ms without scroll
  --viewport WxH    viewport size (default 1440x900 when launching)
  --touch           enable touch emulation before load (on automatically when a step touches)
  --shot <file>     PNG screenshot after the last step
  --headed          show the browser window
  --cdp <url>       use a running browser's DevTools endpoint, e.g. http://127.0.0.1:9222.
                    Attaches to a tab already at <url>; otherwise opens one and closes it at the end
  --chrome <path>   browser binary (default: $CHROME_PATH, Playwright's Chromium, then Google Chrome)
  --timeout <ms>    limit for load, --at, and --wait (default 10000)`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    at: { type: "string" },
    read: { type: "string" },
    wait: { type: "string" },
    viewport: { type: "string" },
    touch: { type: "boolean", default: false },
    shot: { type: "string" },
    headed: { type: "boolean", default: false },
    cdp: { type: "string" },
    chrome: { type: "string" },
    timeout: { type: "string", default: "10000" },
    help: { type: "boolean", short: "h" },
  },
});

const [url, ...stepArgs] = positionals;
if (opt.help || !url) {
  console.log(USAGE);
  process.exit(opt.help ? 0 : 2);
}
const TIMEOUT = Number(opt.timeout);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- gestures

const DIRS = { right: [1, 0], left: [-1, 0], down: [0, 1], up: [0, -1] };

function direction(name) {
  const dir = DIRS[name];
  if (!dir) throw new Error(`direction must be left, right, up, or down: ${name}`);
  return dir;
}

/** Wheel events at fixed spacing: [[dx, dy], ...] → [{t, dx, dy}] */
const spaced = (deltas, gap) => deltas.map(([dx, dy], i) => ({ t: i * gap, dx, dy }));

const along = ([sx, sy], values) => values.map((v) => [sx * v, sy * v]);

function trackpad(dir) {
  // Grows while the fingers push, then the inertia tail shrinks 5% per event down to 1 px
  const values = [2, 5, 12, 25, 40, 45];
  for (let v = 45; v >= 1; v *= 0.95) values.push(Math.round(v));
  return spaced(along(dir, values), 16);
}

function recorded(file) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  const samples = Array.isArray(data) ? data : data.samples;
  if (!Array.isArray(samples) || !samples.length) throw new Error(`${file}: expected [{dt, dx, dy}] or {samples: [...]}`);
  return samples.map((s) => ({ t: s.dt, dx: s.dx ?? 0, dy: s.dy ?? 0 }));
}

/** One finger from the target center along [dx, dy]: 12 moves 16 ms apart, then an optional rest */
function finger(dx, dy, hold) {
  const steps = 12;
  const gap = 16;
  const points = [{ t: 0, type: "touchStart", fx: 0, fy: 0 }];
  for (let i = 1; i <= steps; i += 1) points.push({ t: i * gap, type: "touchMove", fx: (dx * i) / steps, fy: (dy * i) / steps });
  points.push({ t: steps * gap + hold, type: "touchEnd", fx: dx, fy: dy });
  return points;
}

function pair(arg, name) {
  const match = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(arg ?? "");
  if (!match) throw new Error(`${name} takes <dx>,<dy>, e.g. ${name}:-300,0`);
  return [Number(match[1]), Number(match[2])];
}

/** "trackpad:right" → {name, kind, events} */
function parseStep(text) {
  const [name, arg, extra] = text.split(":");
  switch (name) {
    case "trackpad":
      return { kind: "wheel", events: trackpad(direction(arg)) };
    case "mouse":
      return { kind: "wheel", events: spaced(along(direction(arg), [4, 30.7]), 30) };
    case "mouse-fast":
      return { kind: "wheel", events: spaced(along(direction(arg), [4, 146.6, 165.4]), 30) };
    case "mouse-hold": {
      const n = extra === undefined ? 40 : Number(extra);
      return { kind: "wheel", events: spaced(along(direction(arg), [4, ...Array(n).fill(40)]), 33) };
    }
    case "wheel":
      return { kind: "wheel", events: recorded(text.slice("wheel:".length)) };
    case "swipe":
      return { kind: "touch", events: finger(...pair(arg, name), 0) };
    case "drag":
      return { kind: "touch", events: finger(...pair(arg, name), 150) };
    case "tap":
      return { kind: "touch", events: [{ t: 0, type: "touchStart", fx: 0, fy: 0 }, { t: 60, type: "touchEnd", fx: 0, fy: 0 }] };
    case "click":
      return { kind: "click" };
    case "pause":
      return { kind: "pause", ms: Number(arg) };
    default:
      throw new Error(`unknown step: ${text} (see --help)`);
  }
}

let steps;
try {
  steps = stepArgs.map((text) => ({ text, ...parseStep(text) }));
} catch (error) {
  console.error(`replay: ${error.message}`);
  process.exit(2);
}

// ---------------------------------------------------------------- DevTools connection

class Session {
  #id = 0;
  #pending = new Map();
  #listeners = new Map();

  constructor(ws) {
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.method) return this.#listeners.get(msg.method)?.forEach((fn) => fn(msg.params));
      const waiter = this.#pending.get(msg.id);
      if (!waiter) return;
      this.#pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else waiter.resolve(msg.result);
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error(`cannot connect to ${wsUrl}`)), { once: true });
    });
    return new Session(ws);
  }

  send(method, params = {}) {
    const id = (this.#id += 1);
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  once(method) {
    return new Promise((resolve) => {
      const fns = this.#listeners.get(method) ?? [];
      const fn = (params) => {
        fns.splice(fns.indexOf(fn), 1);
        resolve(params);
      };
      fns.push(fn);
      this.#listeners.set(method, fns);
    });
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }
}

function findChrome() {
  if (opt.chrome) return opt.chrome;
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = process.platform === "darwin" ? join(homedir(), "Library/Caches/ms-playwright") : join(homedir(), ".cache/ms-playwright");
  const builds = existsSync(cache)
    ? readdirSync(cache)
        .filter((name) => /^chromium-\d+$/.test(name))
        .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
    : [];
  const inside = [
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-linux64/chrome",
    "chrome-linux/chrome",
  ];
  const system = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const found = [...builds.flatMap((build) => inside.map((rel) => join(cache, build, rel))), ...system].find((path) => existsSync(path));
  if (!found) throw new Error("no Chromium found: run `npx playwright install chromium`, or pass --chrome <path>");
  return found;
}

/** A throwaway browser with its own profile. Returns its HTTP endpoint and a cleanup */
async function launch() {
  const profile = mkdtempSync(join(tmpdir(), "input-replay-"));
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--touch-events=enabled",
    // Keep rAF and timers at full speed in the background
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--autoplay-policy=no-user-gesture-required",
    ...(opt.headed ? [] : ["--headless=new"]),
    "about:blank",
  ];
  const child = spawn(findChrome(), args, { stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolve, reject) => {
    let log = "";
    const timer = setTimeout(() => reject(new Error(`browser did not start in ${TIMEOUT} ms\n${log}`)), TIMEOUT);
    child.once("exit", (code) => reject(new Error(`browser exited (${code})\n${log}`)));
    child.stderr.on("data", (chunk) => {
      log += chunk;
      const match = /DevTools listening on ws:\/\/([^/\s]+)/.exec(log);
      if (match) {
        clearTimeout(timer);
        resolve(`http://${match[1]}`);
      }
    });
  });
  const close = async () => {
    child.kill();
    await new Promise((resolve) => (child.exitCode === null ? child.once("exit", resolve) : resolve()));
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  };
  return { endpoint, close };
}

async function pageTarget(endpoint, launched) {
  const list = await fetch(`${endpoint}/json/list`).then((r) => r.json());
  if (launched) return { target: list.find((t) => t.type === "page"), opened: false };
  const existing = list.find((t) => t.type === "page" && t.url.startsWith(url));
  if (existing) return { target: existing, opened: false };
  const target = await fetch(`${endpoint}/json/new?${encodeURIComponent(url)}`, { method: "PUT" }).then((r) => r.json());
  return { target, opened: true };
}

// ---------------------------------------------------------------- page helpers

// Counts input events that reach the page, and those that land outside --at
// A tab reused over --cdp keeps the listeners of an earlier run, so only the target is replaced
const COUNTER = (at) => `(() => {
  const at = ${JSON.stringify(at ?? null)};
  if (window.__replay) return void (window.__replay.at = at);
  const r = (window.__replay = { got: {}, missed: 0, at });
  for (const type of ["wheel", "touchstart", "touchmove", "touchend", "pointerdown", "pointerup", "click"])
    addEventListener(type, (e) => {
      r.got[type] = (r.got[type] ?? 0) + 1;
      if (r.at && !document.querySelector(r.at)?.contains(e.target)) r.missed += 1;
    }, { capture: true, passive: true });
})()`;

const TAKE_COUNTS = `(() => {
  const r = window.__replay;
  if (!r) return null;
  const out = { got: r.got, missed: r.missed };
  r.got = {};
  r.missed = 0;
  return out;
})()`;

const QUIET = `new Promise((resolve) => {
  let timer;
  const done = () => { removeEventListener("scroll", reset, true); resolve(true); };
  const reset = () => { clearTimeout(timer); timer = setTimeout(done, 500); };
  addEventListener("scroll", reset, { capture: true, passive: true });
  reset();
})`;

async function poll(page, expression, what) {
  const deadline = Date.now() + TIMEOUT;
  let failure = "";
  for (;;) {
    const ok = await page.evaluate(expression).catch((error) => {
      failure = ` (last error: ${String(error.message ?? error).split("\n")[0]})`;
      return false;
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${TIMEOUT} ms waiting for ${what}${failure}`);
    await sleep(50);
  }
}

async function center(page) {
  const point = await page.evaluate(`(() => {
    const at = ${JSON.stringify(opt.at ?? null)};
    if (!at) return { x: innerWidth / 2, y: innerHeight / 2 };
    const el = document.querySelector(at);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
    return { x, y };
  })()`);
  if (!point) throw new Error(`--at matches nothing now: ${opt.at}`);
  return point;
}

/** Sends each event at its own time without waiting for the reply: a reply waits for a frame, which would stretch 16 ms gaps */
async function play(events, send) {
  const start = performance.now();
  const sent = [];
  for (const event of events) {
    const wait = start + event.t - performance.now();
    if (wait > 0) await sleep(wait);
    sent.push(send(event));
  }
  await Promise.all(sent);
  return events.length;
}

async function perform(page, step) {
  if (step.kind === "pause") {
    await sleep(step.ms);
    return 0;
  }
  const { x, y } = await center(page);
  if (step.kind === "wheel") {
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    return play(step.events, ({ dx, dy }) => page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy }));
  }
  if (step.kind === "touch") {
    const sent = await play(step.events, ({ type, fx, fy }) =>
      page.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: x + fx, y: y + fy }] }),
    );
    // --read at the moment the finger lifts: what moves after it is fling or snap
    return { sent, lift: opt.read ? await page.evaluate(opt.read).catch(() => undefined) : undefined };
  }
  const button = { x, y, button: "left", clickCount: 1 };
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, ...button });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...button });
  return 3;
}

async function report(page, step, done, started) {
  const line = { step };
  const { sent, lift } = typeof done === "number" ? { sent: done } : (done ?? {});
  if (sent !== undefined) line.sent = sent;
  if (started !== undefined) line.ms = Math.round(performance.now() - started);
  if (lift !== undefined) line.readAtLift = lift;
  const counts = await page.evaluate(TAKE_COUNTS).catch(() => null);
  if (counts) Object.assign(line, counts);
  if (opt.read) {
    try {
      line.read = await page.evaluate(opt.read);
    } catch (error) {
      line.readError = String(error.message ?? error).split("\n")[0];
    }
  }
  console.log(JSON.stringify(line));
}

// ---------------------------------------------------------------- run

let browser;
let page;
let opened;
let endpoint;
const cleanup = async () => {
  page?.ws.close();
  if (opened) await fetch(`${endpoint}/json/close/${opened}`).catch(() => {});
  await browser?.close();
};
process.once("SIGINT", () => cleanup().finally(() => process.exit(130)));

try {
  if (opt.cdp) endpoint = opt.cdp.replace(/\/$/, "");
  else ({ endpoint, ...browser } = await launch());

  const { target, opened: isNew } = await pageTarget(endpoint, !opt.cdp);
  if (isNew) opened = target.id;
  page = await Session.connect(target.webSocketDebuggerUrl);
  await page.send("Page.enable");
  await page.send("Runtime.enable");

  const viewport = opt.viewport ?? (opt.cdp ? null : "1440x900");
  if (viewport) {
    const [width, height] = viewport.split("x").map(Number);
    // deviceScaleFactor 0 keeps the screen's own: forcing 1 on a 2x display doubles the deltaX the page reads
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 0, mobile: false });
  }
  if (opt.touch || steps.some((s) => s.kind === "touch")) {
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  }
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: COUNTER(opt.at) });

  if (!opt.cdp) {
    const loaded = page.once("Page.loadEventFired");
    await page.send("Page.navigate", { url });
    await Promise.race([loaded, sleep(TIMEOUT).then(() => Promise.reject(new Error(`load timed out: ${url}`)))]);
  } else {
    await poll(page, `document.readyState === "complete"`, "the page to load");
  }
  await page.evaluate(COUNTER(opt.at));

  if (opt.at) {
    await poll(page, `!!document.querySelector(${JSON.stringify(opt.at)})`, `--at ${opt.at}`);
    await page.evaluate(`document.querySelector(${JSON.stringify(opt.at)}).scrollIntoView({ block: "center", inline: "nearest" })`);
  }
  await page.evaluate(QUIET);
  await page.evaluate(TAKE_COUNTS);
  await report(page, "start");

  for (const step of steps) {
    const started = performance.now();
    const sent = await perform(page, step);
    if (opt.wait) await poll(page, opt.wait, `--wait ${opt.wait}`);
    else await page.evaluate(QUIET);
    await report(page, step.text, sent, started);
  }

  if (opt.shot) {
    const { data } = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(opt.shot, Buffer.from(data, "base64"));
  }
} catch (error) {
  console.error(`replay: ${error.message ?? error}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
