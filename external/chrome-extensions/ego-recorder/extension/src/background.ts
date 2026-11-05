import type { CaptureEvent } from "./generated/CaptureEvent";
import type { NetEvent } from "./generated/NetEvent";
import type { Reply } from "./generated/Reply";
import type { ReplyBody } from "./generated/ReplyBody";
import type { Request } from "./generated/Request";
import { type ContentMessage, type PageAnswer, type PageMessage, RECORDING_KEY } from "./messages";

const HOST = "com.hj.ego_recorder";
const BODY_CAP = 2 * 1024 * 1024;
const NO_BODY_TYPES = new Set(["Image", "Media", "Font", "Stylesheet", "Script"]);
const FLUSH_MS = 250;
const SHOT_DELAY_MS = 150;
const STOP_BODY_WAIT_MS = 1500;
const IDLE_DISCONNECT_MS = 3000;
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

type Session = chrome.debugger.DebuggerSession;

interface Inflight {
  event: NetEvent;
  hasPostData: boolean;
}

interface Recording {
  rec: string;
  mainTab: number;
  tabs: Set<number>;
  requests: Map<string, Inflight>;
  bodyWaits: number;
  queue: CaptureEvent[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  shooting: boolean;
  stopping: boolean;
}

let recording: Recording | null = null;
let port: chrome.runtime.Port | null = null;
let nextId = 1;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const pending = new Map<number, { resolve: (reply: ReplyBody) => void; reject: (error: Error) => void }>();

function connect(): chrome.runtime.Port {
  if (port) return port;
  const opened = chrome.runtime.connectNative(HOST);
  opened.onMessage.addListener((message: Reply) => {
    pending.get(message.id)?.resolve(message.reply);
    pending.delete(message.id);
    scheduleIdleDisconnect();
  });
  opened.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message ?? "native host disconnected";
    port = null;
    for (const waiter of pending.values()) waiter.reject(new Error(reason));
    pending.clear();
    // The host runs its stop pass on EOF, so all that is left is to let go of the tab.
    if (recording) void releaseTabs(recording);
  });
  port = opened;
  return opened;
}

function scheduleIdleDisconnect(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!recording && pending.size === 0 && port) {
      port.disconnect();
      port = null;
    }
  }, IDLE_DISCONNECT_MS);
}

function call(request: Request): Promise<ReplyBody> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    connect().postMessage({ id, request });
  });
}

async function hostCall(request: Request): Promise<ReplyBody> {
  const reply = await call(request);
  if (reply.type === "error") throw new Error(reply.message);
  return reply;
}

function send<T = unknown>(session: Session, method: string, params?: object): Promise<T> {
  return chrome.debugger.sendCommand(session, method, params) as Promise<T>;
}

function ignore(): void {}

function enqueue(current: Recording, event: CaptureEvent): void {
  current.queue.push(event);
  current.flushTimer ??= setTimeout(() => flush(current), FLUSH_MS);
}

function flush(current: Recording): void {
  if (current.flushTimer) clearTimeout(current.flushTimer);
  current.flushTimer = null;
  if (current.queue.length === 0) return;
  const events = current.queue;
  current.queue = [];
  call({ type: "events", events }).catch(ignore);
}

function headerList(headers: Record<string, string> | undefined): [string, string][] {
  return Object.entries(headers ?? {});
}

function newInflight(tab: number, top: boolean): Inflight {
  return {
    hasPostData: false,
    event: {
      t: Date.now(),
      tab,
      top,
      method: "",
      url: "",
      resource_type: "",
      req_headers: [],
      post_data: null,
      status: null,
      mime: null,
      res_headers: [],
      body: null,
      body_base64: false,
      truncated: false,
      failed: null,
    },
  };
}

function capped(text: string, isBase64: boolean): { text: string; truncated: boolean } {
  if (text.length <= BODY_CAP) return { text, truncated: false };
  // A base64 string can only be cut on a 4 character boundary and still decode.
  const end = isBase64 ? BODY_CAP - (BODY_CAP % 4) : BODY_CAP;
  return { text: text.slice(0, end), truncated: true };
}

/** Bodies go in their own batch so a large one cannot delay the action events around it. */
function emitNet(current: Recording, event: NetEvent): void {
  if (event.body) flush(current);
  enqueue(current, { type: "net", ...event });
  if (event.body) flush(current);
}

async function completeRequest(current: Recording, session: Session, requestId: string, key: string, failed: string | null): Promise<void> {
  const inflight = current.requests.get(key);
  if (!inflight) return;
  current.requests.delete(key);
  const { event } = inflight;
  event.failed = failed;
  current.bodyWaits += 1;
  try {
    if (inflight.hasPostData && event.post_data === null) {
      const posted = await send<{ postData: string }>(session, "Network.getRequestPostData", { requestId }).catch(() => null);
      if (posted) event.post_data = capped(posted.postData, false).text;
    }
    if (!failed && !NO_BODY_TYPES.has(event.resource_type)) {
      const body = await send<{ body: string; base64Encoded: boolean }>(session, "Network.getResponseBody", { requestId }).catch(() => null);
      if (body) {
        const cut = capped(body.body, body.base64Encoded);
        event.body = cut.text;
        event.body_base64 = body.base64Encoded;
        event.truncated = cut.truncated;
      }
    }
  } finally {
    current.bodyWaits -= 1;
  }
  emitNet(current, event);
}

function onNetwork(current: Recording, source: Session, method: string, params: any): void {
  const { tabId, sessionId } = source;
  if (tabId === undefined) return;
  const key = `${sessionId ?? "top"}:${params.requestId}`;
  const entry = (): Inflight => {
    let inflight = current.requests.get(key);
    if (!inflight) {
      inflight = newInflight(tabId, !sessionId);
      current.requests.set(key, inflight);
    }
    return inflight;
  };
  switch (method) {
    case "Network.requestWillBeSent": {
      if (params.redirectResponse) {
        const previous = current.requests.get(key);
        if (previous) {
          previous.event.status = params.redirectResponse.status;
          previous.event.res_headers = headerList(params.redirectResponse.headers);
          emitNet(current, previous.event);
          current.requests.delete(key);
        }
      }
      const inflight = entry();
      inflight.event.t = params.wallTime * 1000;
      inflight.event.method = params.request.method;
      inflight.event.url = params.request.url;
      inflight.event.resource_type = params.type ?? "Other";
      inflight.event.post_data = params.request.postData ?? null;
      inflight.hasPostData = Boolean(params.request.hasPostData);
      if (inflight.event.req_headers.length === 0) inflight.event.req_headers = headerList(params.request.headers);
      break;
    }
    case "Network.requestWillBeSentExtraInfo":
      entry().event.req_headers = headerList(params.headers);
      break;
    case "Network.responseReceived": {
      const { event } = entry();
      event.status = params.response.status;
      event.mime = params.response.mimeType;
      event.resource_type = params.type ?? event.resource_type;
      if (event.res_headers.length === 0) event.res_headers = headerList(params.response.headers);
      break;
    }
    case "Network.responseReceivedExtraInfo":
      entry().event.res_headers = headerList(params.headers);
      break;
    case "Network.loadingFinished":
      void completeRequest(current, source, params.requestId, key, null);
      break;
    case "Network.loadingFailed":
      void completeRequest(current, source, params.requestId, key, params.errorText ?? "failed");
      break;
  }
}

async function setUpChild(tabId: number, sessionId: string): Promise<void> {
  const child: Session = { tabId, sessionId };
  await send(child, "Network.enable", { maxPostDataSize: BODY_CAP }).catch(ignore);
  await send(child, "Target.setAutoAttach", AUTO_ATTACH).catch(ignore);
  // The frame stays paused until here, which is what guarantees its first request is seen.
  await send(child, "Runtime.runIfWaitingForDebugger").catch(ignore);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const current = recording;
  if (!current || source.tabId === undefined || !current.tabs.has(source.tabId)) return;
  if (method.startsWith("Network.")) {
    onNetwork(current, source, method, params);
  } else if (method === "Target.attachedToTarget") {
    void setUpChild(source.tabId, (params as { sessionId: string }).sessionId);
  }
});

chrome.debugger.onDetach.addListener((source) => {
  const current = recording;
  if (!current || source.tabId === undefined) return;
  current.tabs.delete(source.tabId);
  if (source.tabId === current.mainTab && !current.stopping) void stopRecording(null).catch(ignore);
});

async function attach(tabId: number): Promise<void> {
  const session: Session = { tabId };
  await chrome.debugger.attach(session, "1.3");
  await send(session, "Network.enable", { maxPostDataSize: BODY_CAP });
  await send(session, "Target.setAutoAttach", AUTO_ATTACH);
}

async function shoot(current: Recording, tabId: number): Promise<void> {
  if (current.shooting || current.stopping || !current.tabs.has(tabId)) return;
  current.shooting = true;
  try {
    const shot = await send<{ data: string }>({ tabId }, "Page.captureScreenshot", { format: "jpeg", quality: 50 });
    enqueue(current, { type: "shot", t: Date.now(), tab: tabId, jpeg_base64: shot.data });
  } catch {
    // A tab mid-navigation cannot be captured; the next action or load takes its own.
  } finally {
    current.shooting = false;
  }
}

async function startRecording(tabId: number): Promise<RecorderStateValue> {
  if (recording) throw new Error("이미 녹화 중입니다");
  const tab = await chrome.tabs.get(tabId);
  const started = await hostCall({ type: "start", tab_url: tab.url ?? "", title: tab.title ?? "" });
  if (started.type !== "started") throw new Error("unexpected reply to start");
  const current: Recording = {
    rec: started.rec,
    mainTab: tabId,
    tabs: new Set([tabId]),
    requests: new Map(),
    bodyWaits: 0,
    queue: [],
    flushTimer: null,
    shooting: false,
    stopping: false,
  };
  recording = current;
  try {
    await attach(tabId);
  } catch (error) {
    recording = null;
    await hostCall({ type: "stop", goal: null }).catch(ignore);
    await hostCall({ type: "delete", rec: started.rec }).catch(ignore);
    throw error;
  }
  await chrome.storage.session.set({ [RECORDING_KEY]: true });
  await chrome.action.setBadgeBackgroundColor({ color: "#d11" });
  await chrome.action.setBadgeText({ text: "REC" });
  return { rec: started.rec, tabId };
}

type RecorderStateValue = { rec: string; tabId: number };

async function releaseTabs(current: Recording): Promise<void> {
  current.stopping = true;
  for (const tabId of current.tabs) await chrome.debugger.detach({ tabId }).catch(ignore);
  recording = null;
  await chrome.storage.session.remove(RECORDING_KEY);
  await chrome.action.setBadgeText({ text: "" });
}

async function stopRecording(goal: string | null): Promise<ReplyBody> {
  const current = recording;
  if (!current) throw new Error("녹화 중이 아닙니다");
  current.stopping = true;
  const deadline = Date.now() + STOP_BODY_WAIT_MS;
  while (current.bodyWaits > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  for (const { event } of current.requests.values()) emitNet(current, event);
  current.requests.clear();
  flush(current);
  await releaseTabs(current);
  return hostCall({ type: "stop", goal });
}

function captureFrom(sender: chrome.runtime.MessageSender, message: ContentMessage): void {
  const current = recording;
  const tab = sender.tab?.id;
  if (!current || current.stopping || tab === undefined || !current.tabs.has(tab)) return;
  enqueue(current, { type: "action", ...message.action, tab });
  if (message.action.kind === "click" || message.action.kind === "submit") {
    setTimeout(() => void shoot(current, tab), SHOT_DELAY_MS);
  }
}

async function answerPage(message: PageMessage): Promise<PageAnswer> {
  switch (message.to) {
    case "rpc":
      return { ok: true, reply: await call(message.request) };
    case "state":
      return { ok: true, state: recording ? { rec: recording.rec, tabId: recording.mainTab } : null };
    case "start":
      return { ok: true, state: await startRecording(message.tabId) };
    case "stop":
      return { ok: true, reply: await stopRecording(message.goal) };
  }
}

chrome.runtime.onMessage.addListener((message: PageMessage | ContentMessage, sender, respond) => {
  if (message.to === "capture") {
    captureFrom(sender, message);
    return false;
  }
  // Web pages can reach content scripts, never this: only the extension's own pages may drive the host.
  if (!sender.url?.startsWith(chrome.runtime.getURL(""))) return false;
  answerPage(message).then(respond, (error: Error) => respond({ ok: false, error: error.message }));
  return true;
});

function navigated(tab: number, frame: number, url: string, transition: string, t: number): void {
  const current = recording;
  if (!current || frame !== 0 || !current.tabs.has(tab) || !url.startsWith("http")) return;
  enqueue(current, { type: "nav", t, tab, url, transition });
}

chrome.webNavigation.onCommitted.addListener((d) => navigated(d.tabId, d.frameId, d.url, d.transitionType, d.timeStamp));
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => navigated(d.tabId, d.frameId, d.url, "history", d.timeStamp));
chrome.webNavigation.onCompleted.addListener((d) => {
  if (recording && d.frameId === 0) void shoot(recording, d.tabId);
});
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  const current = recording;
  if (!current || !current.tabs.has(d.sourceTabId)) return;
  current.tabs.add(d.tabId);
  attach(d.tabId).catch(ignore);
});

void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });

// A worker restart loses the in-memory recording, and the host has already stopped it on EOF.
void chrome.storage.session.get(RECORDING_KEY).then(async (stored) => {
  if (stored[RECORDING_KEY] && !recording) {
    await chrome.storage.session.remove(RECORDING_KEY);
    await chrome.action.setBadgeText({ text: "" });
    for (const target of await chrome.debugger.getTargets()) {
      if (target.attached && target.tabId !== undefined) await chrome.debugger.detach({ tabId: target.tabId }).catch(ignore);
    }
  }
});
