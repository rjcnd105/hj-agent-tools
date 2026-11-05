import type { RecordingSummary } from "./generated/RecordingSummary";
import { ask, isHostMissing, rpc } from "./messages";

const CONFIRM_RESET_MS = 3000;
const COPIED_RESET_MS = 1500;

const control = document.querySelector<HTMLElement>("#control")!;
const list = document.querySelector<HTMLUListElement>("#list")!;
const message = document.querySelector<HTMLElement>("#message")!;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function showError(error: unknown): void {
  const text = error instanceof Error ? error.message : String(error);
  message.hidden = false;
  if (isHostMissing(text)) {
    message.textContent = "네이티브 호스트가 설치되지 않았습니다. 터미널에서 실행하세요: ";
    message.append(element("code", "", "ego-rec install"));
  } else {
    message.textContent = text;
  }
}

function clearError(): void {
  message.hidden = true;
  message.textContent = "";
}

/** `?tab=` lets the E2E open this page in a tab of its own, where the active tab is the page itself. */
async function targetTab(): Promise<number | undefined> {
  const given = new URLSearchParams(location.search).get("tab");
  if (given) return Number(given);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function renderIdle(): void {
  const start = element("button", "primary", "이 탭 녹화 시작");
  start.id = "start";
  start.addEventListener("click", async () => {
    clearError();
    const tabId = await targetTab();
    if (tabId === undefined) return showError(new Error("녹화할 탭을 찾지 못했습니다"));
    const answer = await ask({ to: "start", tabId });
    if (!answer.ok) return showError(new Error(answer.error));
    await refresh();
  });
  control.replaceChildren(start);
}

function renderRecording(): void {
  const goal = element("input", "");
  goal.type = "text";
  goal.id = "goal";
  goal.placeholder = "목표 (선택)";
  goal.setAttribute("aria-label", "목표");
  const stop = element("button", "primary", "중지");
  stop.id = "stop";
  stop.addEventListener("click", async () => {
    clearError();
    stop.disabled = true;
    const answer = await ask({ to: "stop", goal: goal.value.trim() || null });
    if (!answer.ok) showError(new Error(answer.error));
    else if (answer.reply?.type === "error") showError(new Error(answer.reply.message));
    await refresh();
  });
  const status = element("p", "muted", "녹화 중입니다.");
  status.style.margin = "0";
  control.replaceChildren(status, goal, stop);
  goal.focus();
}

function inputChips(item: RecordingSummary): HTMLElement {
  const chips = element("div", "chips");
  for (const field of item.inputs) {
    if (field.present) {
      chips.append(element("span", "chip saved", `${field.label} 저장됨`));
      continue;
    }
    const chip = element("button", "chip missing", `${field.label} 입력 필요`);
    chip.addEventListener("click", () => {
      const keys = item.inputs.filter((i) => !i.present).map((i) => i.key).join(",");
      const url = chrome.runtime.getURL(`input.html?rec=${item.id}&keys=${encodeURIComponent(keys)}`);
      void chrome.tabs.create({ url });
    });
    chips.append(chip);
  }
  return chips;
}

function row(item: RecordingSummary): HTMLLIElement {
  const li = element("li", "");
  li.dataset.rec = item.id;
  const time = new Date(item.created_at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const steps = item.recording ? "녹화 중" : `${item.steps}단계`;
  li.append(element("div", "title", item.title || item.id), element("div", "muted", `${time} · ${steps}`));
  if (item.inputs.length > 0) li.append(inputChips(item));
  if (item.recording) return li;

  const copy = element("button", "copy", "프롬프트 복사");
  copy.addEventListener("click", async () => {
    clearError();
    try {
      const reply = await rpc({ type: "prompt", rec: item.id });
      if (reply.type !== "prompt") throw new Error("unexpected reply");
      await navigator.clipboard.writeText(reply.text);
      copy.textContent = "복사됨";
      setTimeout(() => {
        copy.textContent = "프롬프트 복사";
      }, COPIED_RESET_MS);
    } catch (error) {
      showError(error);
    }
  });

  const remove = element("button", "delete", "삭제");
  let armed = false;
  remove.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      remove.textContent = "정말 삭제";
      remove.classList.add("danger");
      setTimeout(() => {
        armed = false;
        remove.textContent = "삭제";
        remove.classList.remove("danger");
      }, CONFIRM_RESET_MS);
      return;
    }
    clearError();
    try {
      await rpc({ type: "delete", rec: item.id });
      await refresh();
    } catch (error) {
      showError(error);
    }
  });

  const actions = element("div", "actions");
  actions.append(copy, remove);
  li.append(actions);
  return li;
}

async function refresh(): Promise<void> {
  const state = await ask({ to: "state" });
  if (state.ok && state.state) renderRecording();
  else renderIdle();
  try {
    const reply = await rpc({ type: "list" });
    if (reply.type === "recordings") list.replaceChildren(...reply.items.map(row));
  } catch (error) {
    showError(error);
  }
}

void refresh();
