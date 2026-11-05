// Drives the user's running ego lite in one TaskSpace, so it uses their real profile, data directory,
// and Keychain. It touches only what it creates: its own recording, ledger, cookie, and mock origin.
const EXT_ID = "hacjfebiagkihcmmobkiniihcclmlhpd";

if (typeof taskSpace === "undefined") {
  const { spawnSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const self = fileURLToPath(import.meta.url);
  const manifest = path.join(os.homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.hj.ego_recorder.json");
  if (!fs.existsSync(manifest)) {
    console.error(`PREFLIGHT the native host is not installed. Run \`just build\` first.\n  missing ${manifest}`);
    process.exit(2);
  }
  const config = {
    root: path.resolve(path.dirname(self), ".."),
    bin: JSON.parse(fs.readFileSync(manifest, "utf8")).path,
    idleMs: Number(process.env.E2E_IDLE_MS ?? 65_000),
    env: { HOME: os.homedir(), PATH: process.env.PATH, TMPDIR: os.tmpdir() },
  };
  const source = `globalThis.__e2e = ${JSON.stringify(config)};\n${fs.readFileSync(self, "utf8")}`;
  process.exit(spawnSync("ego-browser", ["nodejs"], { input: source, stdio: ["pipe", "inherit", "inherit"] }).status ?? 1);
}

// The embedded runtime exits on a pending await unless a timer keeps its loop alive.
const keepAlive = setInterval(() => {}, 1000);
const { execFileSync, spawn } = await import("node:child_process");
const fs = await import("node:fs");
const path = await import("node:path");
const { root: ROOT, bin: BIN, idleMs: IDLE_MS, env: childEnv } = globalThis.__e2e;
const { startMock } = await import(path.join(ROOT, "e2e/mock.mjs"));
const DIST = path.join(ROOT, "extension/dist");
const SERVICE = "ego-recorder";
const ONCE_SUFFIX = "#once";
const REC_HOME = path.join(childEnv.HOME, ".local/share/ego-recorder");
const POPUP = `chrome-extension://${EXT_ID}/popup.html`;
const SENSITIVE_KEYS = ["login.username", "login.password", "card.number", "card.exp", "card.cvc"];

const CANARY = {
  email: "canary.user+e2e@example.test",
  password: "C@nary!Pass 77",
  number: "CANARYPANQ4111",
  exp: "EXPCANARYZ",
  cvc: "CVC7Q3",
};

const tmp = fs.mkdtempSync(path.join(childEnv.TMPDIR, "ego-rec-e2e-"));

const failures = [];
const measured = {};
const transcript = [];

function check(condition, message, detail) {
  if (condition) {
    console.log(`PASS ${message}`);
    return;
  }
  failures.push(message);
  console.log(`FAIL ${message}${detail === undefined ? "" : `\n     ${String(detail).slice(0, 2000)}`}`);
}

function egoRecSync(...args) {
  const output = execFileSync(BIN, args, { env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  transcript.push(output);
  return output;
}

function egoRec(args, timeout = 120_000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(BIN, args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      transcript.push(output);
      resolve({ code, signal, output, ms: Date.now() - started });
    });
  });
}

const task = await taskSpace("ego-recorder e2e");
const tab = task.page("p1");
const recordingsBefore = new Set(fs.existsSync(path.join(REC_HOME, "recordings")) ? fs.readdirSync(path.join(REC_HOME, "recordings")) : []);
let mock;
let recordedTabId;
let scriptPath;
let scriptSpace;
let scope;
let recording = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(probe, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let failure;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
      failure = undefined;
    } catch (error) {
      failure = error;
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}${failure ? `: ${failure.message}` : ""}`);
    await sleep(100);
  }
}

const rectOf = (page, selector) =>
  until(
    () =>
      page.evaluate((sel) => {
        const element = document.querySelector(sel);
        if (!element) return null;
        element.scrollIntoView({ block: "center" });
        const r = element.getBoundingClientRect();
        return r.width ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
      }, selector),
    `element ${selector}`,
  );

async function click(page, selector) {
  const r = await rectOf(page, selector);
  await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2);
}

async function clickAndType(page, selector, text) {
  await click(page, selector);
  await page.keyboard.type(text);
}

/** A cross-origin frame's fields are reachable only by page coordinates, which the mock frame reports. */
async function clickInFrame(page, field) {
  const rects = await until(
    () =>
      page.evaluate(() => {
        document.querySelector("#pg").contentWindow.postMessage("rects", "*");
        return window.__frameRects;
      }),
    "frame field positions",
  );
  const frame = await rectOf(page, "#pg");
  const inner = rects[field];
  await page.mouse.click(frame.x + inner.x + inner.w / 2, frame.y + inner.y + inner.h / 2);
}

const extensionWorkerListed = async () =>
  (await task.cdp("Target.getTargets")).targetInfos.some((t) => t.type === "service_worker" && t.url.includes(EXT_ID));

/** chrome.action.openPopup() needs the frontmost app, so the real popup page runs in a tab, told which tab it targets. */
async function openPopup() {
  const page = await task.newPage();
  await page.goto(`${POPUP}?tab=${recordedTabId}`);
  await until(() => page.evaluate(() => document.querySelector("#start, #stop") !== null), "popup render");
  return page;
}

const badge = (popup) => popup.evaluate(() => chrome.action.getBadgeText({}));

async function deleteMockCookie() {
  const { cookies } = await tab.cdp("Network.getCookies", { urls: [mock.origin] });
  for (const c of cookies.filter((cookie) => cookie.name === "ego_rec_e2e_session")) {
    await tab.cdp("Network.deleteCookies", { name: c.name, domain: c.domain, path: c.path });
  }
}

/** Types into a form and reports what it showed. A running script closes the form once it sees the flag. */
async function answerForm(page, values) {
  await until(() => page.evaluate(() => document.querySelector("form input") !== null), "form fields");
  const shown = await page.evaluate(() => ({
    names: [...document.querySelectorAll("form input[type=password]")].map((i) => i.name),
    boxes: document.querySelectorAll("form input[type=checkbox]").length,
    focused: document.activeElement?.name,
    text: document.body.innerText,
  }));
  for (const name of shown.names) await clickAndType(page, `[name="${name}"]`, values[name]);
  await page.keyboard.press("Enter");
  shown.done = await until(() => page.evaluate(() => window.__egoRecDone === true).catch(() => true), "form done").catch(() => false);
  return shown;
}

/** `ego-rec run` works in its own TaskSpace, so the form is reached through that space. */
async function formInScriptSpace(finished) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (finished()) throw new Error("the command ended without opening a form");
    const space = (await listTaskSpaces()).find((s) => s.name === scriptSpace);
    if (space) {
      const form = (await (await taskSpace(space.id)).tabs()).find((t) => t.url.includes("/input.html"));
      if (form) return form.page;
    }
    await sleep(200);
  }
  throw new Error("timed out waiting for the input form");
}

async function runWithForm(args, values) {
  let finished = false;
  const running = egoRec(args).then((result) => {
    finished = true;
    return result;
  });
  const form = await formInScriptSpace(() => finished)
    .then((page) => answerForm(page, values))
    .catch((error) => ({ error: error.message }));
  return { ...(await running), form };
}

function variants(value) {
  const utf8 = Buffer.from(value);
  const b64 = utf8.toString("base64");
  return [
    value,
    value.toLowerCase(),
    encodeURIComponent(value),
    encodeURIComponent(value).replaceAll("%20", "+"),
    b64,
    b64.replace(/=+$/, ""),
    b64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
    JSON.stringify(value).slice(1, -1),
  ];
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

function canaryHits(sources) {
  const hits = [];
  for (const [name, bytes] of sources) {
    for (const [label, canary] of Object.entries(CANARY)) {
      for (const variant of new Set(variants(canary))) {
        if (bytes.includes(variant)) hits.push(`${label} as ${JSON.stringify(variant)} in ${name}`);
      }
    }
  }
  return hits;
}

function keychainHasItems() {
  return SENSITIVE_KEYS.some((key) => {
    try {
      execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", `${scope}/${key}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
}

async function preflight() {
  const problem = (text) => {
    throw Object.assign(new Error(text), { preflight: true });
  };
  await tab.goto(POPUP).catch(() =>
    problem(`the extension is not loaded in ego lite. At chrome://extensions, load the unpacked folder\n  ${DIST}`),
  );
  await until(() => tab.evaluate(() => document.querySelector("#start, #stop") !== null), "popup render");
  await sleep(1000);
  const state = await tab.evaluate(() => ({
    recording: document.querySelector("#stop") !== null,
    message: document.querySelector("#message").hidden ? "" : document.querySelector("#message").innerText,
  }));
  if (state.message) problem(`the popup reports: ${state.message}`);
  if (state.recording) problem("a recording is in progress in ego lite. Stop it first, since the extension records one tab at a time.");
}

async function main() {
  await preflight();

  mock = await startMock();
  scope = new URL(mock.origin).host;
  await tab.goto(`${mock.origin}/login`);
  const lookup = await task.newPage();
  await lookup.goto(POPUP);
  recordedTabId = await lookup.evaluate((origin) => chrome.tabs.query({}).then((tabs) => tabs.find((t) => t.url.startsWith(origin))?.id), mock.origin);
  await lookup.close();
  if (recordedTabId === undefined) throw new Error("chrome.tabs cannot see the TaskSpace tab");

  let popup = await openPopup();
  await click(popup, "#start");
  await until(() => popup.evaluate(() => document.querySelector("#stop") !== null), "recording state in the popup");
  recording = true;
  await popup.close();
  const recordingStarted = Date.now();

  await clickAndType(tab, "#email", CANARY.email);
  await clickAndType(tab, "#password", CANARY.password);
  await click(tab, "#login");
  await until(async () => (await tab.evaluate(() => location.pathname + document.readyState)) === "/checkoutcomplete", "checkout page");

  await clickAndType(tab, "#qty", "3");
  await tab.keyboard.press("Tab");
  await tab.keyboard.type("f");
  await until(() => tab.evaluate(() => document.querySelector("#delivery").value === "fast"), "type-ahead on the delivery select");
  await clickInFrame(tab, "cardNumber");
  await tab.keyboard.type(CANARY.number);
  await clickInFrame(tab, "cardExp");
  await tab.keyboard.type(CANARY.exp);
  await clickInFrame(tab, "cardCvc");
  await tab.keyboard.type(CANARY.cvc);
  await click(tab, "#qty");

  const idleStart = Date.now();
  let workerGone = 0;
  let polls = 0;
  while (Date.now() - idleStart < IDLE_MS) {
    await sleep(5000);
    polls += 1;
    if (!(await extensionWorkerListed())) workerGone += 1;
  }
  measured.swIdleSeconds = Math.round((Date.now() - idleStart) / 1000);
  measured.swMissingPolls = `${workerGone}/${polls}`;
  check(workerGone === 0, `service worker stayed listed through ${measured.swIdleSeconds}s of idle recording`, measured.swMissingPolls);

  await click(tab, "#pay");
  await until(() => tab.evaluate(() => document.querySelector("#receipt").textContent !== ""), "receipt", 20_000);
  check(mock.state.charges === 1, "recorded session charged once", mock.state.charges);
  measured.recordingSeconds = Math.round((Date.now() - recordingStarted) / 1000);

  popup = await openPopup();
  check((await badge(popup)) === "REC", "the toolbar badge reads REC while recording");
  await click(popup, "#goal");
  await popup.keyboard.insertText("E2E 결제 자동화");
  await click(popup, "#stop");
  await until(() => popup.evaluate(() => document.querySelector("#start") !== null), "idle state in the popup", 20_000);
  recording = false;
  const rec = await until(
    async () => (await popup.evaluate(() => [...document.querySelectorAll("li[data-rec]")].map((li) => li.dataset.rec))).find((id) => !recordingsBefore.has(id)),
    "the new recording in the popup list",
    20_000,
  );
  const item = `li[data-rec="${rec}"]`;
  // The popup renders its idle state before the refreshed list arrives, so the row can still read as recording.
  const row = await until(
    async () => {
      const text = await popup.evaluate((sel) => document.querySelector(sel).innerText, item);
      return /단계/.test(text) && text;
    },
    "the stopped recording's row",
    20_000,
  );
  check(/E2E|주문|로그인/.test(row) && /단계/.test(row), "assertion 1: recording appears in the popup list with title, time and step count", row);
  check((await badge(popup)) === "", "the badge clears after stop");

  const dir = path.join(REC_HOME, "recordings", rec);
  check(!fs.existsSync(path.join(dir, "spool.ndjson")), "the spool is gone after stop");
  const flow = JSON.parse(fs.readFileSync(path.join(dir, "flow.json"), "utf8"));
  scope = flow.scope;
  const api = (needle) => flow.api.find((a) => a.url_template.includes(needle));
  const tokenize = api("/api/tokenize");
  const charge = api("/api/charge");
  check(tokenize && tokenize.top === false, "assertion 2: the iframe's tokenize call appears in flow.json", JSON.stringify(flow.api));
  const csrfDep = charge?.deps.find((d) => d.field.includes("csrf"));
  check(csrfDep && api("/api/csrf")?.id === csrfDep.from.id, "assertion 2: the charge's CSRF field traces back to the csrf response", JSON.stringify(charge));
  const payStep = flow.steps.find((s) => s.at_most_once);
  check(payStep?.expect?.response?.url.includes("/api/charge"), "the Pay click is at_most_once and expects the charge response", JSON.stringify(payStep));
  const inputKeys = flow.inputs.map((i) => i.key).sort();
  check(JSON.stringify(inputKeys) === JSON.stringify([...SENSITIVE_KEYS].sort()), "flow inputs are the five sensitive fields", inputKeys);
  const qtyParam = flow.params.find((p) => p.recorded_value === "3");
  check(qtyParam, "qty became a param with its recorded value", JSON.stringify(flow.params));
  check(flow.steps.some((s) => s.kind === "select"), "the delivery choice became a select step", JSON.stringify(flow.steps));

  const prompt = egoRecSync("prompt", rec);
  measured.promptBytes = Buffer.byteLength(prompt);
  check(measured.promptBytes <= 1200, `assertion 4: prompt is ${measured.promptBytes} bytes, at most 1200`);

  await popup.evaluate(() => {
    navigator.clipboard.writeText = async (text) => {
      window.__copied = text;
    };
  });
  await click(popup, `${item} .copy`);
  const feedback = await until(() => popup.evaluate((sel) => document.querySelector(sel).textContent === "복사됨", `${item} .copy`), "copy feedback").catch(() => false);
  const copied = await popup.evaluate(() => window.__copied);
  check(feedback && copied === prompt, "assertion 4: the copy button hands over the exact prompt, with visible feedback", String(copied).slice(0, 200));

  const show = egoRecSync("show", rec);
  console.log(`--- prompt\n${prompt}--- show\n${show}---`);
  measured.showBytes = Buffer.byteLength(show);
  measured.showNetBytes = Buffer.byteLength(egoRecSync("show", rec, "--net"));
  for (const step of flow.steps) egoRecSync("show", rec, "--step", String(step.n));
  const shotStep = flow.steps.find((s) => s.shot !== undefined && s.shot !== null);
  if (shotStep) check(fs.existsSync(egoRecSync("show", rec, "--shot", String(shotStep.n)).trim()), "--shot prints an existing path");

  for (const key of ["login.username", "login.password", "card.number", "card.exp"]) {
    const label = { "login.username": "email", "login.password": "password", "card.number": "number", "card.exp": "exp" }[key];
    const value = JSON.parse(execFileSync(BIN, ["input", "get", rec, key], { env: childEnv, encoding: "utf8" }))[key];
    check(value === CANARY[label], `assertion 3: ${key} is in the Keychain`, "value differs");
  }
  check(JSON.parse(egoRecSync("input", "missing", rec, "card.cvc"))[0] === "card.cvc", "CVC was never persisted");

  const chipText = await popup.evaluate((sel) => document.querySelector(sel).innerText, item);
  check(chipText.includes("저장됨") && chipText.includes("입력 필요"), "popup chips show 저장됨 and 입력 필요", chipText);
  await click(popup, `${item} .chip.missing`);
  const chipTab = await until(async () => (await task.tabs()).find((t) => t.url.includes("/input.html")), "the form opened by the chip");
  const chipPage = chipTab.label ? chipTab.page : await task.adopt(chipTab.page);
  const chipForm = await answerForm(chipPage, { "card.cvc": CANARY.cvc });
  check(chipForm.done && JSON.stringify(chipForm.names) === '["card.cvc"]', "clicking 입력 필요 opens the form", JSON.stringify(chipForm));
  await chipPage.close();
  await popup.close();

  scriptPath = path.join(tmp, "automations", `ego-rec-e2e-${new URL(mock.origin).port}.mjs`);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  const compileStart = Date.now();
  egoRecSync("compile", rec, "-o", scriptPath);
  measured.compileMs = Date.now() - compileStart;
  scriptSpace = JSON.parse(/const SCRIPT = ("[^"]+");/.exec(fs.readFileSync(scriptPath, "utf8"))[1]);

  const charges = () => mock.state.charges;
  const tested = await egoRec(["test", scriptPath]);
  measured.testMs = tested.ms;
  check(tested.code === 0 && charges() === 1 && mock.state.attempts === 1, `assertion 5: test exits 0, charges stay at 1, stops before Pay (${tested.ms}ms)`, `code ${tested.code} charges ${charges()}\n${tested.output}`);
  check(tested.output.includes("STOPPED before step") && tested.output.includes("already logged in"), "assertion 5: test reports the stop and the logged-in skip", tested.output);

  const loggedIn = await runWithForm(["run", scriptPath], { "card.cvc": CANARY.cvc });
  check(loggedIn.code === 0 && charges() === 2 && loggedIn.output.includes("already logged in"), "assertion 5: run in the logged-in state charges exactly once", `code ${loggedIn.code} charges ${charges()}\n${loggedIn.output}\n${JSON.stringify(loggedIn.form)}`);
  check(mock.state.lastCharge?.qty === "3" && mock.state.lastCharge?.delivery === "fast", "the replayed charge carries the recorded qty and delivery", JSON.stringify(mock.state.lastCharge));
  check(
    JSON.stringify(loggedIn.form.names) === '["card.cvc"]' && loggedIn.form.boxes === 0 && loggedIn.form.focused === "card.cvc" && loggedIn.form.text?.includes("이번 실행에만 사용") && loggedIn.form.done,
    "assertion 6: the form shows only the CVC, focused, with no save box, and completes",
    JSON.stringify(loggedIn.form),
  );
  check(JSON.parse(egoRecSync("input", "missing", rec, "card.cvc"))[0] === "card.cvc", "assertion 6: the once-only CVC is gone after the run");

  await deleteMockCookie();
  const loginsBefore = mock.state.logins;
  const loggedOut = await runWithForm(["run", scriptPath], { "card.cvc": CANARY.cvc });
  check(loggedOut.code === 0 && charges() === 3 && mock.state.logins === loginsBefore + 1, "assertion 5: run in the logged-out state logs in and charges exactly once", `code ${loggedOut.code} charges ${charges()} logins ${mock.state.logins}\n${loggedOut.output}\n${JSON.stringify(loggedOut.form)}`);

  mock.state.hang = true;
  const attemptsBefore = mock.state.attempts;
  const unknown = await runWithForm(["run", scriptPath], { "card.cvc": CANARY.cvc });
  mock.state.hang = false;
  check(unknown.code === 3 && unknown.output.includes("UNKNOWN: verify before rerunning") && mock.state.attempts === attemptsBefore + 1, "assertion 7: a charge with no answer exits 3 with UNKNOWN after one attempt", `code ${unknown.code} attempts ${mock.state.attempts}\n${unknown.output.slice(-800)}`);
  const refused = await egoRec(["run", scriptPath]);
  check(refused.code === 4 && refused.output.includes("--again") && mock.state.attempts === attemptsBefore + 1, "assertion 7: the next run is refused and touches nothing", `code ${refused.code}\n${refused.output}`);
  const chargesBefore = charges();
  const again = await runWithForm(["run", scriptPath, "--again", "--param", `${qtyParam?.name}=5`], { "card.cvc": CANARY.cvc });
  check(again.code === 0 && charges() === chargesBefore + 1, "assertion 7: --again runs and charges", `code ${again.code} charges ${charges()}\n${again.output}\n${JSON.stringify(again.form)}`);
  check(mock.state.lastCharge?.qty === "5", "--param overrides the recorded qty", JSON.stringify(mock.state.lastCharge));

  const ledger = path.join(REC_HOME, "runs", `${path.parse(scriptPath).name}.jsonl`);
  const sources = [...walk(dir), ledger].map((file) => [path.relative(REC_HOME, file), fs.readFileSync(file)]);
  sources.push(["compiled script", fs.readFileSync(scriptPath)], ["cli and run output", Buffer.from(transcript.join("\n"))]);
  const hits = canaryHits(sources);
  check(hits.length === 0, `assertion 3: no canary in ${sources.length} sources (prompt, show, flow, events, blobs, script, run output)`, hits.join("\n"));
  const sessionLeaks = sources.filter(([, bytes]) => [...mock.sessions].some((session) => bytes.includes(session))).map(([name]) => name);
  check(mock.sessions.size > 0 && sessionLeaks.length === 0, "no session cookie value in any source", sessionLeaks.join("\n"));
  const loosePaths = [REC_HOME, path.join(REC_HOME, "recordings"), dir, ...walk(dir)].filter((file) => fs.statSync(file).mode & 0o077);
  check(loosePaths.length === 0, "recording files and directories are private to the user", loosePaths.join("\n"));

  check(keychainHasItems(), "the Keychain holds this recording's items before delete");
  popup = await openPopup();
  const removeButton = `${item} .delete`;
  await click(popup, removeButton);
  check((await popup.evaluate((sel) => document.querySelector(sel).textContent, removeButton)) === "정말 삭제" && fs.existsSync(dir), "delete asks in-page before removing anything");
  await click(popup, removeButton);
  await until(() => !fs.existsSync(dir), "recording directory removal");
  check(!fs.existsSync(dir), "assertion 8: delete removes the recording directory");
  check(!keychainHasItems(), "assertion 8: delete removes the Keychain items");
  await popup.close();
}

/** Each step stands alone, so one failure cannot leave the rest of the test's state behind. */
async function cleanup() {
  const attempt = async (label, work) => {
    try {
      await work();
    } catch (error) {
      console.log(`CLEANUP ${label}: ${error.message}`);
    }
  };
  if (recording) {
    await attempt("stop recording", async () => {
      const popup = await openPopup();
      await click(popup, "#stop");
      await until(() => popup.evaluate(() => document.querySelector("#start") !== null), "idle state", 20_000);
      await popup.close();
    });
  }
  const recordings = path.join(REC_HOME, "recordings");
  if (mock && fs.existsSync(recordings)) {
    for (const id of fs.readdirSync(recordings).filter((name) => !recordingsBefore.has(name))) {
      const meta = fs.readFileSync(path.join(recordings, id, "meta.json"), "utf8");
      if (meta.includes(mock.origin)) await attempt(`remove recording ${id}`, () => egoRecSync("rm", id));
    }
  }
  if (scriptPath) fs.rmSync(path.join(REC_HOME, "runs", `${path.parse(scriptPath).name}.jsonl`), { force: true });
  if (scope) {
    for (const key of SENSITIVE_KEYS) {
      for (const account of [`${scope}/${key}`, `${scope}/${key}${ONCE_SUFFIX}`]) {
        try {
          execFileSync("security", ["delete-generic-password", "-s", SERVICE, "-a", account], { stdio: "ignore" });
        } catch {}
      }
    }
  }
  if (mock) await attempt("session cookie", deleteMockCookie);
  if (scriptSpace) {
    await attempt("script space", async () => {
      const space = (await listTaskSpaces()).find((s) => s.name === scriptSpace);
      if (space) await (await taskSpace(space.id)).finish({ keep: [] });
    });
  }
  mock?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  await attempt("test space", () => task.finish({ keep: [] }));
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  if (error.preflight) {
    console.log(`PREFLIGHT ${error.message}`);
    exitCode = 2;
  } else {
    failures.push(error.message);
    console.log(`FATAL ${error.stack}`);
  }
}
if (exitCode === 0) {
  if (failures.length > 0) exitCode = 1;
  console.log(`measured ${JSON.stringify(measured)}`);
  console.log(failures.length ? `${failures.length} FAILED` : "ALL PASSED");
}
await cleanup();
clearInterval(keepAlive);
process.exit(exitCode);
