import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../../herdr/lib/mod-config.js", import.meta.url));
const { createModConfig, expandHome, normalizeDir } =
  await import(`data:text/javascript;base64,${source.toString("base64")}`);

test("expandHome and normalizeDir handle ~, relative paths, and trailing slashes", () => {
  assert.equal(expandHome("~", "/Users/hj"), "/Users/hj");
  assert.equal(expandHome("~/custom/mod", "/Users/hj"), "/Users/hj/custom/mod");
  assert.equal(normalizeDir("  ~/custom/mod///  ", "/Users/hj", "/fallback"), "/Users/hj/custom/mod");
  assert.equal(normalizeDir("./presets/", "/Users/hj", "/fallback"), "/Users/hj/presets");
  assert.equal(normalizeDir("   ", "/Users/hj", "/fallback"), "/fallback");
  assert.equal(normalizeDir("/", "/Users/hj", "/fallback"), "/");
});

test("createModConfig resolves env overrides in priority order and skips exec while checking()", async () => {
  let execCount = 0;
  const env = { PRIMARY_ENV: "   ", FALLBACK_ENV: "~/override/team/" };
  const exec = async (_cmd, [name]) => {
    execCount++;
    const value = env[name];
    return value !== undefined ? { code: 0, stdout: `${value}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
  };
  let isChecking = true;
  const cfg = createModConfig({
    mod: "hj-team",
    envVars: ["PRIMARY_ENV", "FALLBACK_ENV"],
    file: "_config.json",
    defaults: { visiblePresetRows: 3 },
    home: () => "/Users/hj",
    exec,
    readTextFile: async () => null,
    checking: () => isChecking,
  });

  assert.equal(await cfg.resolveDir(), "/Users/hj/.herdr/hj-team");
  assert.equal(execCount, 0);

  isChecking = false;
  assert.equal(await cfg.resolveDir(), "/Users/hj/override/team");
  assert.equal(await cfg.resolvePath(), "/Users/hj/override/team/_config.json");
  const countAfterResolve = execCount;
  assert.equal(await cfg.resolveDir(), "/Users/hj/override/team");
  assert.equal(execCount, countAfterResolve);
});

test("createModConfig falls back to ~/.herdr/<mod>, validates JSON, and isolates errors in loadSafe", async () => {
  const files = {
    "/Users/hj/.herdr/hj-pane/config.json": JSON.stringify({ colors: { dark: { rest: "#112233" } } }),
  };
  const cfg = createModConfig({
    mod: "hj-pane",
    envVars: ["HERDR_MOD_HJ_PANE_DIR"],
    defaults: { colors: { dark: { rest: "#33435a" } } },
    validate: (parsed, defaults) => ({
      colors: { dark: { rest: parsed?.colors?.dark?.rest ?? defaults.colors.dark.rest } },
    }),
    home: () => "/Users/hj",
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    readTextFile: async (path) => files[path] ?? null,
    checking: () => false,
  });

  const loaded = await cfg.load();
  assert.equal(loaded.dir, "/Users/hj/.herdr/hj-pane");
  assert.equal(loaded.exists, true);
  assert.equal(loaded.config.colors.dark.rest, "#112233");

  files["/Users/hj/.herdr/hj-pane/config.json"] = "{ invalid json";
  await assert.rejects(() => cfg.load());
  const safe = await cfg.loadSafe();
  assert.equal(safe.exists, false);
  assert.equal(safe.config.colors.dark.rest, "#33435a");
  assert.ok(safe.error);
});

test("createModConfig mount notifies every mounted view on config change and recovers after watch failure", async () => {
  let content = JSON.stringify({ pollMs: 5000 });
  let attempt = 0;
  let retryCb = null;
  let triggerChange = null;
  const notified = [];
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const makeCx = (id) => ({
    spawn(fn) { fn(makeCx(id)); },
    timer: {
      after(_ms, fn) {
        retryCb = fn;
        return { cancel() { retryCb = null; } };
      },
    },
    notify() { notified.push(id); },
  });
  const watchFolder = () => {
    attempt++;
    if (attempt === 1) return Promise.reject(new Error("ENOENT"));
    const p = new Promise((resolve) => { triggerChange = resolve; });
    p.cancel = () => { triggerChange?.([]); };
    return p;
  };
  const cfg = createModConfig({
    mod: "hj-files",
    envVars: ["HERDR_MOD_HJ_FILES_DIR"],
    defaults: { pollMs: 10000 },
    home: () => "/Users/hj",
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    readTextFile: async () => content,
    checking: () => false,
  });

  let latest = null;
  const v1 = { id: "v1" }, v2 = { id: "v2" };
  const opts = { watchFolder, retryMs: 0, onConfig: ({ config }) => { latest = config.pollMs; }, onChange: (_r, cx) => cx.notify() };
  cfg.mount(v1, makeCx("v1"), opts);
  cfg.mount(v2, makeCx("v2"), opts);
  await flush();
  assert.equal(latest, 5000);
  assert.deepEqual(notified, ["v1", "v2"]);

  // The missing folder parks the loop with no timer; render's wake() retries, then v1 closes and
  // v2 takes over; changing the file notifies v2.
  assert.equal(retryCb, null);
  cfg.wake(v1, makeCx("v1"));
  await flush();
  assert.equal(attempt, 2);
  cfg.unmount(v1);
  await flush();
  notified.length = 0;
  content = JSON.stringify({ pollMs: 2500 });
  triggerChange(["config.json"]);
  await flush();
  assert.equal(latest, 2500);
  assert.deepEqual(notified, ["v2"]);
  cfg.unmount(v2);
});

test("createModConfig parks the watch while the mod is hidden and wake() resumes it with a reload", async () => {
  let content = JSON.stringify({ pollMs: 5000 });
  let shown = false, watches = 0, release = null, latest = null;
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const cx = { spawn(fn) { fn(cx); }, timer: { after() { throw new Error("no timer while parked"); } }, notify() {} };
  const watchFolder = () => {
    watches++;
    const p = new Promise((resolve) => { release = resolve; });
    p.cancel = () => release([]);
    return p;
  };
  const cfg = createModConfig({
    mod: "hj-files",
    envVars: [],
    defaults: { pollMs: 10000 },
    home: () => "/Users/hj",
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    readTextFile: async () => content,
    checking: () => false,
  });
  const view = {};
  cfg.mount(view, cx, { watchFolder, shown: () => shown, onConfig: ({ config }) => { latest = config.pollMs; } });
  await flush();
  assert.equal(latest, 5000);
  assert.equal(watches, 0);

  content = JSON.stringify({ pollMs: 2500 });
  shown = true;
  cfg.wake(view, cx);
  await flush();
  assert.equal(latest, 2500);
  assert.equal(watches, 1);

  // Hidden again: the next change reloads once and parks instead of watching again.
  shown = false;
  content = JSON.stringify({ pollMs: 1000 });
  release(["config.json"]);
  await flush();
  assert.equal(latest, 1000);
  assert.equal(watches, 1);
  cfg.wake(view, cx);
  await flush();
  assert.equal(watches, 1);
  cfg.unmount(view);
});
