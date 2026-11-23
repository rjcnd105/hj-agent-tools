// A pane's header (cloned from "pane" in herdr-app 0.1.16) that always shows
// the terminal's hc address, and marks a sub-agent's pane: its parent's address
// before its own, and a blue frame, pale at rest and deeper with the keyboard.
//   { "tab": "active", "pane": { "header": { "content": { "mod": "hj-pane" } },
//       "gap": 0, "radius": 0,
//       "border": { "width": 0, "color": "border" }, "focus": { "width": 0, "color": "border" } } }
// The layout's own focus frame sits inside the blue one and would show there.
// With "focus" no different from "border", as above, this mod draws the focus
// frame of every pane instead: blue for a sub-agent, a quiet gray otherwise.
// With a "border" of no width it draws one-pixel seams between panes. Sub-agents
// that sit together share one blue frame that changes color on focus.
// A sub-agent is any terminal with a parent, however it was started.
// Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, terminals, props, run, exec, checking, theme, home, layout, settings, readTextFile, watchFolder } from "herdr";
// Copied from herdr/lib/mod-config.js by `just herdr-mods`.
import { createModConfig } from "./mod-config.js";

// A sub-agent's frame: the pale one at rest, the deep one with the keyboard.
// `main` frames any other pane that has the keyboard: quieter than the accent.
const DEFAULT_COLORS = { dark: { rest: "#33435a", focus: "#5878a6", main: "#6e6e6e" }, light: { rest: "#b9c7db", focus: "#5b7cae", main: "#a3a3a3" } };
const hex = (v, fallback) => typeof v === "string" && /^#[0-9a-fA-F]{6,8}$/.test(v.trim()) ? v.trim() : fallback;
const modConfig = createModConfig({
  mod: "hj-pane",
  envVars: ["HERDR_MOD_HJ_PANE_DIR"],
  defaults: { colors: DEFAULT_COLORS },
  validate(parsed) {
    const pick = (mode) => ({
      rest: hex(parsed?.colors?.[mode]?.rest, DEFAULT_COLORS[mode].rest),
      focus: hex(parsed?.colors?.[mode]?.focus, DEFAULT_COLORS[mode].focus),
      main: hex(parsed?.colors?.[mode]?.main, DEFAULT_COLORS[mode].main),
    });
    return { colors: { dark: pick("dark"), light: pick("light") } };
  },
  home, exec, readTextFile, checking,
});
let paneColors = { dark: { ...DEFAULT_COLORS.dark }, light: { ...DEFAULT_COLORS.light } };
let configRevision = 0;
const mountConfig = (view, cx) => modConfig.mount(view, cx, {
  watchFolder,
  onConfig({ config }) {
    paneColors = config.colors;
    configRevision++;
    sweep();
  },
  onChange(_result, cx) { cx.notify(); },
});

// What the layout leaves to this mod: `focus` when its own focus frame doesn't
// differ from its border, `rest` when it draws no border.
function duty(look) {
  const rest = !(look?.border?.width > 0);
  const focus = !(look?.focus?.width > 0) || look.focus.color === look.border?.color;
  // One pixel outside the layout's frame, with its corner.
  return { rest, focus, radius: look?.radius ? look.radius + 1 : 0 };
}

// One write of frames at a time; `again` when one was asked for meanwhile.
// `framedAt` is when the last one began, `queuedAt` when a header last set a
// timer for one. Module state, so the headers share it.
let framedAt = 0, queuedAt = 0, sweeping = false, again = false;

// One request to the core, which keeps the app's tabs in its "herdr-app" document.
async function core(method, params) {
  const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  // The request travels as an argument, and the system caps those near 1 MiB.
  if (request.length > 400000) throw new Error("the layout document is too large to send");
  const out = await exec("sh", ["-c", 'printf "%s\\n" "$1" | hc connect', "sh", request], { timeout: 5000 });
  const reply = JSON.parse(out.stdout.split("\n")[0]);
  if (reply.error) throw new Error(reply.error.message);
  return reply.result;
}

// The layout frames every pane alike, so a pane's own frame is written on its
// block in the tab tree, where the app draws it one pixel outside the layout's.
// Where the layout draws no border, two frames side by side would make a seam
// two pixels wide: the seams are the dividers of the tree's rows and columns
// instead, and sub-agents that sit together share one frame around them all.
// One write frames every pane that lacks its frame; headers ask once between them.
async function frame() {
  const line = (b) => (b ? `${b.width} ${b.color}` : "");
  const look_of = (n) => [line(n.border), line(n.focus?.border), line(n.divider), n.radius ?? ""].join("|");
  for (let attempt = 0; attempt < 3; attempt++) {
    // Read on every attempt: the appearance can change while a write waits.
    const blue = paneColors[settings().dark ? "dark" : "light"];
    const { rest, focus, radius } = duty(paneFrame(layout()));
    const kids = new Set(terminals().filter((k) => k.parent).map((k) => k.address));
    const doc = await core("doc.get", { name: "herdr-app" });
    let changed = false;
    const put = (node, want) => {
      if (look_of(want) === look_of(node)) return;
      for (const [key, value] of Object.entries(want)) if (value === undefined) delete node[key]; else node[key] = value;
      changed = true;
    };
    // Whether every pane under a node is a sub-agent's.
    const sub = (node) => (node.type === "block" ? kids.has(node.content?.terminal) : Boolean(node.children?.length) && node.children.every(sub));
    const visit = (node, framed) => {
      // The outermost node that holds only sub-agents carries their one frame.
      const onlyKids = sub(node);
      const group = rest && !framed && onlyKids;
      if (node.type === "block") {
        if (!node.content?.terminal || (!onlyKids && !focus)) return;
        put(node, {
          // Reserve space for a pane's own focus frame, but not inside a group frame.
          border: framed ? undefined : { width: 1, color: onlyKids && (group || !rest) ? blue.rest : "#00000000" },
          focus: framed ? undefined : { border: { width: 1, color: onlyKids ? blue.focus : blue.main } },
          divider: undefined,
          radius,
        });
        return;
      }
      // Clear a previous group frame if its panes change, without removing unrelated focus styles.
      const wasGroup = [...Object.values(DEFAULT_COLORS), ...Object.values(paneColors)].some((colors) =>
        node.border?.width === 1 && node.border.color === colors.rest &&
        node.focus?.border?.width === 1 && node.focus.border.color === colors.focus);
      put(node, {
        border: group ? { width: 1, color: blue.rest } : undefined,
        focus: group ? { border: { width: 1, color: blue.focus } } : wasGroup ? undefined : node.focus,
        divider: rest ? { width: 1, color: onlyKids ? blue.rest : "border" } : undefined,
        radius: node.radius,
      });
      for (const child of node.children ?? []) visit(child, framed || group);
    };
    for (const space of doc.value?.spaces ?? []) for (const tab of space.tabs ?? []) visit(tab.root, false);
    if (!changed) return;
    try {
      await core("doc.set", { name: "herdr-app", value: doc.value, version: doc.version });
      return;
    } catch (e) {
      // The app wrote in between: read again.
      if (e.message !== "conflict") throw e;
    }
  }
  throw new Error("the app kept changing its tabs: frames not written");
}

// Runs one write at a time, and again for whatever was asked for meanwhile,
// a few times at most. A failed one is reported and doesn't stop the next.
async function sweep() {
  if (sweeping) { again = true; return; }
  sweeping = true;
  for (let round = 0; round < 4; round++) {
    again = false;
    framedAt = Date.now();
    try { await frame(); } catch (e) { console.error(`hj-pane: ${e.message}`); }
    if (!again) break;
  }
  sweeping = false;
}

// Match the first visible tab frame, including the active child of a stack.
function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter(child => !child.hidden);
    children = [visible.find(child => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init(_props, cx) {
    this.hovered = false;
    mountConfig(this, cx);
    this.paint(cx, this.frameKey(panes(), paneFrame(layout()), settings().dark));
  }

  close() {
    modConfig.unmount(this);
  }

  // Asks for the frames once. Off the render path: it runs a program.
  paint(cx, key, tries = 0) {
    // A check runs init for real: it leaves the document alone.
    if (checking()) return;
    this.framed = key;
    const pane = props()?.pane;
    // Panes on another machine live in that machine's document: left as they are.
    if (!pane || pane.includes("/")) return;
    // Headers that ask together share the first one's timer.
    const asked = Date.now();
    if (!tries && asked - queuedAt < 100) return;
    queuedAt = asked;
    cx.timer.after(tries ? 1500 : 100, (cx) => {
      // The terminal list can arrive after the pane.
      const mine = panes().find((q) => q.pane === pane)?.terminal;
      if (mine && !terminals().some((k) => k.address === mine)) { if (tries < 2) this.paint(cx, key, tries + 1); return; }
      // A write that began after this one asked has framed this pane too.
      if (framedAt > asked) return;
      sweep();
    });
  }

  // What the frames depend on: the appearance, what the layout leaves to this
  // mod, and how many panes there are (one that closes can leave sub-agents alone together).
  frameKey(all, look, dark) {
    const mine = duty(look);
    return `${dark} ${mine.rest} ${mine.focus} ${mine.radius} ${all.length} ${configRevision}`;
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane/${icon}.svg`).size(14));
  }

  render(cx) {
    modConfig.wake(this, cx);
    const t = theme();
    const all = panes(), id = props()?.pane;
    const p = all.find((q) => q.pane === id);
    if (!p) return div();
    const term = p.terminal && terminals().find((k) => k.address === p.terminal);
    const parent = term?.parent ?? null;
    const name = term?.name || ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    const look = paneFrame(layout());
    const bottom = look?.header?.position === "bottom";
    const dark = settings().dark;
    const blue = paneColors[dark ? "dark" : "light"];
    const line = parent ? (p.focused ? blue.focus : blue.rest) : t.border;
    // A switch between light and dark, or a layout edit, changes the frames.
    const key = this.frameKey(all, look, dark);
    if (this.framed && this.framed !== key) this.paint(cx, key);
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .when(bottom, el => el.border_t(1))
      .when(!bottom, el => el.border_b(1))
      .border_color(line)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .when(Boolean(parent), el => el.child(div().flex_none().text_size(10.5).text_color(t.muted + "73").child(parent)))
      .when(Boolean(p.terminal), el => el.child(div().flex_none().text_size(10.5).text_color((parent ? blue.focus : t.muted) + "a6").child(p.terminal)))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
