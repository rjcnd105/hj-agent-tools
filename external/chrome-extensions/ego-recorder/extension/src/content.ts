import type { ActionKind } from "./generated/ActionKind";
import type { HiddenField } from "./generated/HiddenField";
import type { Target } from "./generated/Target";
import type { ContentMessage } from "./messages";
import { RECORDING_KEY } from "./messages";

const TEXT_CAP = 80;
const HIDDEN_CAP = 50;
const DEBOUNCE_MS = 400;
const NAME_SCAN_CAP = 500;
const NON_VALUE_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "image", "file"]);
const IMPLICIT_ROLE: Record<string, string> = { button: "button", select: "combobox", textarea: "textbox", summary: "button" };
const INPUT_ROLE: Record<string, string> = {
  button: "button",
  submit: "button",
  reset: "button",
  image: "button",
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  number: "spinbutton",
  search: "searchbox",
};

let active = false;
let pendingField: Element | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

void chrome.storage.session
  .get(RECORDING_KEY)
  .then((stored) => {
    active = Boolean(stored[RECORDING_KEY]);
  })
  .catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && RECORDING_KEY in changes) active = Boolean(changes[RECORDING_KEY]?.newValue);
});

function clean(text: string | null | undefined): string | null {
  const collapsed = text?.replace(/\s+/g, " ").trim();
  return collapsed ? collapsed.slice(0, TEXT_CAP) : null;
}

function labelText(element: Element): string | null {
  const labels = (element as HTMLInputElement).labels;
  const label = labels?.[0] ?? element.closest("label");
  return clean(label?.textContent);
}

function implicitRole(element: Element): string | null {
  const tag = element.localName;
  if (tag === "input") return INPUT_ROLE[(element as HTMLInputElement).type] ?? "textbox";
  if (tag === "a") return element.hasAttribute("href") ? "link" : null;
  return element.getAttribute("role") ?? IMPLICIT_ROLE[tag] ?? null;
}

function roleOf(element: Element): string | null {
  return element.getAttribute("role") ?? implicitRole(element);
}

function accessibleName(element: Element): string | null {
  const labelled = element.getAttribute("aria-labelledby");
  if (labelled) {
    const text = labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    if (clean(text)) return clean(text);
  }
  const named = clean(element.getAttribute("aria-label")) ?? labelText(element);
  if (named) return named;
  if (element.localName === "input") {
    const input = element as HTMLInputElement;
    if (NON_VALUE_INPUTS.has(input.type)) return clean(input.value);
    return clean(input.placeholder) ?? clean(input.title);
  }
  return clean(element.textContent) ?? clean(element.getAttribute("title"));
}

function isOnly(root: ParentNode, selector: string): boolean {
  try {
    return root.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

function attrSelector(name: string, value: string): string {
  return `[${name}="${CSS.escape(value)}"]`;
}

function cssPath(element: Element): string {
  const parts: string[] = [];
  let node: Element | null = element;
  while (node && node !== document.documentElement) {
    const current: Element = node;
    if (current.id && !/\d{3}|:/.test(current.id)) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      break;
    }
    const sameTag = Array.from(current.parentElement?.children ?? []).filter((c) => c.localName === current.localName);
    const position = sameTag.length > 1 ? `:nth-of-type(${sameTag.indexOf(current) + 1})` : "";
    parts.unshift(`${current.localName}${position}`);
    node = current.parentElement;
  }
  return parts.join(" > ");
}

/** Counts matching role plus name the way a replay locator would, with a cap for huge pages. */
function uniqueBy(element: Element, read: (candidate: Element) => string | null, value: string | null): boolean {
  if (!value) return false;
  const candidates = document.querySelectorAll("a,button,input,select,textarea,summary,[role]");
  if (candidates.length > NAME_SCAN_CAP) return false;
  const role = roleOf(element);
  let matches = 0;
  for (const candidate of candidates) {
    if (roleOf(candidate) === role && read(candidate) === value) matches += 1;
  }
  return matches === 1;
}

function describe(element: Element): Target {
  const input = element as HTMLInputElement;
  const tag = element.localName;
  const testid = element.getAttribute("data-testid");
  const id = element.id || null;
  const nameAttr = element.getAttribute("name");
  const role = roleOf(element);
  const name = accessibleName(element);
  const label = labelText(element);
  const css = cssPath(element);
  return {
    tag,
    role,
    name,
    label,
    text: tag === "input" || tag === "textarea" || tag === "select" ? null : clean(element.textContent),
    id,
    name_attr: nameAttr,
    input_type: tag === "input" ? input.type : null,
    autocomplete: element.getAttribute("autocomplete"),
    placeholder: element.getAttribute("placeholder"),
    testid,
    css,
    frame_url: location.href,
    unique: {
      testid: testid ? isOnly(document, attrSelector("data-testid", testid)) : false,
      role: uniqueBy(element, accessibleName, name),
      id: id ? isOnly(document, attrSelector("id", id)) : false,
      name_attr: nameAttr ? isOnly(document, `${tag}${attrSelector("name", nameAttr)}`) : false,
      label: uniqueBy(element, labelText, label),
      css: isOnly(document, css),
    },
  };
}

function hiddenFields(): HiddenField[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>("input[type=hidden]"))
    .slice(0, HIDDEN_CAP)
    .filter((field) => field.name && field.value)
    .map((field) => ({ name: field.name, value: field.value }));
}

function send(kind: ActionKind, element: Element, extra: { value?: string | null; key?: string | null; hidden?: HiddenField[] } = {}): void {
  const message: ContentMessage = {
    to: "capture",
    action: { t: Date.now(), kind, target: describe(element), value: extra.value ?? null, key: extra.key ?? null, hidden: extra.hidden ?? [] },
  };
  void chrome.runtime.sendMessage(message).catch(() => {});
}

function targetOf(event: Event): Element | null {
  const target = event.composedPath()[0];
  return target instanceof Element ? target : null;
}

function fieldValue(element: Element): string | null {
  if (element instanceof HTMLInputElement) return NON_VALUE_INPUTS.has(element.type) ? null : element.value;
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return element.value;
  if (element instanceof HTMLElement && element.isContentEditable) return element.innerText;
  return null;
}

function flushInput(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  const field = pendingField;
  pendingField = null;
  if (!field) return;
  const value = fieldValue(field);
  if (value !== null) send("input", field, { value });
}

function clickable(element: Element): Element {
  return element.closest("button,a,input,select,textarea,summary,label,[role],[onclick]") ?? element;
}

document.addEventListener(
  "click",
  (event) => {
    if (!active || !event.isTrusted) return;
    const raw = targetOf(event);
    if (!raw) return;
    flushInput();
    const element = clickable(raw);
    // The browser forwards a label click to its control, and that second click is the one to replay.
    if (element.localName === "label" && (element as HTMLLabelElement).control) return;
    // Enter in a field makes the browser click the default button. The Enter is already a step.
    if (event.detail === 0 && document.activeElement !== element) return;
    send("click", element, { hidden: hiddenFields() });
  },
  true,
);

document.addEventListener(
  "input",
  (event) => {
    if (!active) return;
    const element = targetOf(event);
    if (!element || fieldValue(element) === null) return;
    // Leading edge: a sensitive field must seal the tab's screenshots from the first keystroke.
    const isNewField = pendingField !== element;
    if (isNewField) flushInput();
    pendingField = element;
    if (isNewField) {
      const first = element;
      send("input", first, { value: fieldValue(first) });
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushInput, DEBOUNCE_MS);
  },
  true,
);

document.addEventListener(
  "change",
  (event) => {
    if (!active) return;
    const element = targetOf(event);
    if (!element) return;
    if (pendingField === element) flushInput();
    const value = fieldValue(element);
    if (value !== null) send("change", element, { value });
  },
  true,
);

document.addEventListener("focusout", () => active && flushInput(), true);
document.addEventListener("pointerdown", () => active && flushInput(), true);

document.addEventListener(
  "submit",
  (event) => {
    if (!active) return;
    flushInput();
    const element = targetOf(event);
    if (element) send("submit", element, { hidden: hiddenFields() });
  },
  true,
);

document.addEventListener(
  "keydown",
  (event) => {
    if (!active || !event.isTrusted || !["Enter", "Tab", "Escape"].includes(event.key)) return;
    flushInput();
    const element = targetOf(event);
    if (element) send("key", element, { key: event.key, hidden: event.key === "Enter" ? hiddenFields() : [] });
  },
  true,
);
