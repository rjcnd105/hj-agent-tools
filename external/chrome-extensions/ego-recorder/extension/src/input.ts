import type { InputField } from "./generated/InputField";
import { rpc } from "./messages";

declare global {
  interface Window {
    __egoRecDone?: boolean;
  }
}

const form = document.querySelector<HTMLFormElement>("#form")!;
const heading = document.querySelector<HTMLElement>("#heading")!;
const message = document.querySelector<HTMLElement>("#message")!;
const query = new URLSearchParams(location.search);
const rec = query.get("rec") ?? "";
const wanted = query.get("keys")?.split(",").filter(Boolean) ?? [];

function done(): void {
  heading.textContent = "입력이 완료되었습니다. 이 탭은 닫아도 됩니다.";
  form.replaceChildren();
  window.__egoRecDone = true;
}

function fieldRow(field: InputField): HTMLElement {
  const row = document.createElement("div");
  row.className = "field";

  const label = document.createElement("label");
  label.className = "name";
  label.htmlFor = field.key;
  label.textContent = field.label;

  const input = document.createElement("input");
  input.id = field.key;
  input.name = field.key;
  input.type = "password";
  input.required = true;
  input.autocomplete = "off";

  row.append(label, input);
  if (field.storage === "keychain") {
    const save = document.createElement("label");
    save.className = "save";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = true;
    box.dataset.saveFor = field.key;
    save.append(box, "저장");
    row.append(save);
  } else {
    const hint = document.createElement("span");
    hint.className = "hint muted";
    hint.textContent = "이번 실행에만 사용";
    row.append(hint);
  }
  return row;
}

async function load(): Promise<void> {
  const reply = await rpc({ type: "input_status", rec });
  if (reply.type !== "inputs") throw new Error("unexpected reply");
  const fields = reply.fields.filter((f) => !f.present && (wanted.length === 0 || wanted.includes(f.key)));
  if (fields.length === 0) return done();

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primary";
  submit.textContent = "확인";
  form.replaceChildren(...fields.map(fieldRow), submit);
  form.querySelector<HTMLInputElement>("input")?.focus();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    message.hidden = true;
    try {
      for (const field of fields) {
        const input = document.getElementById(field.key) as HTMLInputElement;
        const persist = form.querySelector<HTMLInputElement>(`input[data-save-for="${CSS.escape(field.key)}"]`)?.checked ?? false;
        await rpc({ type: "set_input", rec, key: field.key, value: input.value, persist });
      }
      done();
    } catch (error) {
      submit.disabled = false;
      message.hidden = false;
      message.textContent = error instanceof Error ? error.message : String(error);
    }
  });
}

load().catch((error: unknown) => {
  message.hidden = false;
  message.textContent = error instanceof Error ? error.message : String(error);
});
