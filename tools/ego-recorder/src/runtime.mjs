
const { execFile } = await import("node:child_process");
const { bin: EGO_REC_BIN, env: EGO_REC_ENV } = globalThis.__egoRec;
const ACT_TIMEOUT = 15_000;
const CONFIRM_TIMEOUT = 30_000;
const FORM_TIMEOUT = 600_000;
const fetchedSecrets = new Set();

function egoRec(...argv) {
  return new Promise((resolve, reject) => {
    execFile(EGO_REC_BIN, argv, { env: EGO_REC_ENV }, (error, stdout, stderr) => {
      if (error) reject(new Error(`ego-rec ${argv[0]} ${argv[1]}: ${stderr.trim()}`));
      else resolve(stdout);
    });
  });
}

function clean(text) {
  let out = String(text);
  for (const secret of fetchedSecrets) out = out.replaceAll(secret, "***");
  return out;
}

const task = await taskSpace(SCRIPT);
const pages = [task.page("p1")];

async function ensureInputs(keys) {
  if (!keys.length) return;
  const missing = JSON.parse(await egoRec("input", "missing", REC, ...keys));
  if (!missing.length) return;
  const form = await task.newPage();
  await form.goto(`chrome-extension://${EXT_ID}/input.html?rec=${REC}&keys=${encodeURIComponent(missing.join(","))}`);
  await form.waitForFunction(() => window.__egoRecDone === true, undefined, { timeout: FORM_TIMEOUT });
  await form.close();
}

async function input(key) {
  const value = JSON.parse(await egoRec("input", "get", REC, key))[key];
  if (value === undefined) throw new Error(`no value for ${key}`);
  fetchedSecrets.add(value);
  return value;
}

async function firstLocator(page, locators, timeout = ACT_TIMEOUT) {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (const locator of locators) {
      const found = await page.waitForSelector(locator, { state: "visible", timeout: 300 }).then(() => true, () => false);
      if (found) return locator;
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(200);
  }
}

async function act(page, locators, action) {
  const deadline = Date.now() + ACT_TIMEOUT;
  for (;;) {
    let failure;
    for (const locator of locators) {
      try {
        return await action(locator);
      } catch (error) {
        failure = error;
      }
    }
    if (Date.now() >= deadline) throw failure;
    await page.waitForTimeout(250);
  }
}

function urlPattern(template) {
  const escaped = template.split("{}").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+");
  return new RegExp(`^${escaped}/?([?#].*)?$`);
}

async function stepValue(step) {
  if ("secret" in step.value) {
    if (!START_INPUTS.includes(step.value.secret)) await ensureInputs([step.value.secret]);
    return input(step.value.secret);
  }
  if ("param" in step.value) return String(PARAMS[step.value.param]);
  return step.value.literal;
}

async function perform(page, step) {
  switch (step.kind) {
    case "goto":
      await page.goto(step.value.literal, { timeout: ACT_TIMEOUT * 2 });
      break;
    case "click":
      await act(page, step.locators, (locator) => page.click(locator, { timeout: 3000 }));
      break;
    case "fill": {
      const value = await stepValue(step);
      await act(page, step.locators, (locator) => page.fill(locator, value, { clearFirst: true, timeout: 3000 }));
      break;
    }
    case "select": {
      const value = await stepValue(step);
      await act(page, step.locators, (locator) => page.selectOption(locator, value, { timeout: 3000 }));
      break;
    }
    case "press":
      if (step.locators?.length) await act(page, step.locators, (locator) => page.press(locator, step.value.literal));
      else await page.keyboard.press(step.value.literal);
      break;
  }
}

async function waitForResponse(page, expect) {
  const deadline = Date.now() + CONFIRM_TIMEOUT;
  const sent = new Map();
  for (;;) {
    for (const event of await page.events()) {
      const params = event.params ?? {};
      if (event.method === "Network.requestWillBeSent" && params.request?.method === expect.method) {
        if (urlPattern(expect.url).test(params.request.url)) sent.set(params.requestId, true);
      }
      if (event.method === "Network.responseReceived" && sent.has(params.requestId)) {
        const status = params.response.status;
        if (status >= 400) throw new Error(`${expect.method} ${expect.url} answered ${status}`);
        return;
      }
    }
    if (Date.now() >= deadline) throw new Error(`no response from ${expect.method} ${expect.url}`);
    await page.waitForTimeout(200);
  }
}

async function performAtMostOnce(page, step) {
  const locator = await firstLocator(page, step.locators);
  if (!locator) throw new Error(`no locator matched for step ${step.n}`);
  if (step.expect?.response) {
    await page.cdp("Network.enable");
    await page.events();
  }
  armed = true;
  await page.click(locator, { timeout: 5000 });
  if (step.expect?.response) await waitForResponse(page, step.expect.response);
  if (step.expect?.url) await page.waitForURL(urlPattern(step.expect.url), { timeout: CONFIRM_TIMEOUT });
  if (!step.expect && step === STEPS.at(-1)) throw new Error("the payment has no observable confirmation");
}

// Set once a payment click may have happened: from here on, no failure proves it did not.
let armed = false;
let current = STEPS[0];
try {
  await ensureInputs(START_INPUTS);
  for (let index = 0; index < STEPS.length; index += 1) {
    const step = STEPS[index];
    current = step;
    if (STOP_BEFORE_AT_MOST_ONCE && step.n === TEST_STOP_STEP) {
      console.log(`STOPPED before step ${step.n}; test mode never runs it.`);
      break;
    }
    const page = pages[step.tab ?? 0];
    if (LOGIN && step.n === LOGIN.from) {
      const present = await firstLocator(page, step.locators, 3000);
      if (!present && (!LOGIN.post_url || urlPattern(LOGIN.post_url).test(await page.url()))) {
        index = STEPS.findIndex((s) => s.n === LOGIN.to);
        console.log(`already logged in; skipped steps ${LOGIN.from}-${LOGIN.to}`);
        continue;
      }
    }
    const opensTab = STEPS[index + 1]?.tab === pages.length;
    const popup = opensTab ? page.waitForEvent("popup", { timeout: ACT_TIMEOUT }) : null;
    if (step.at_most_once) await performAtMostOnce(page, step);
    else await perform(page, step);
    if (popup) pages.push(await popup);
    if (step.expect?.url && !step.at_most_once) await page.waitForURL(urlPattern(step.expect.url), { timeout: ACT_TIMEOUT });
  }
  console.log(`OK ${SCRIPT}`);
  await task.finish({ keep: [] });
} catch (error) {
  console.error(`FAILED at step ${current.n}: ${clean(error?.message ?? error)}`);
  const snapshot = await pages.at(-1).snapshot().catch(() => "");
  if (snapshot) console.error(clean(snapshot));
  if (armed) {
    console.error("UNKNOWN: verify before rerunning");
    process.exit(3);
  }
  process.exit(1);
}
