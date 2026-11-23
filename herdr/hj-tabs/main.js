// The app's tab bar (cloned from "tabs" in herdr-app 0.1.16) with sub-tabs.
// A sub-tab is a tab whose first pane runs a sub-agent of a terminal shown in
// another tab of the same space: its super. However the sub-agent was started,
// its parent says so. The bar leaves sub-tabs out and marks the super while
// one of its sub-tabs shows. A second copy draws them in a row below:
//   { "id": "hj-subtabs", "type": "block", "hidden": true, "size": { "px": 34 },
//     "content": { "mod": "hj-tabs", "props": { "row": "sub" } } }
// "super" first, then each sub-tab as "<super's address> <names>". The bar
// shows that block while the shown tab has sub-tabs or is one. In a layout
// without the block every tab stays in the bar, so none is out of reach.
// The bar also gives every live sub-agent that has no pane one in a sub-tab,
// two side by side in each. `terminal.park` takes one back out for good.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, terminals, props, run, hc, exec, home, checking, openOverlay, theme, window, shared, layout, settings, readTextFile, watchFolder } from "herdr";
// Copied from herdr/lib/mod-config.js by `just herdr-mods`.
import { createModConfig, posNum } from "./mod-config.js";
import { shownIn } from "./shown.js";

const DEFAULT_CONFIG = {
  subRowId: "hj-subtabs",
  wheelFirstStepPx: 20,
  wheelRepeatStepPx: 60,
  wheelDebounceMs: 100,
};
const modConfig = createModConfig({
  mod: "hj-tabs",
  envVars: ["HERDR_MOD_HJ_TABS_DIR"],
  defaults: DEFAULT_CONFIG,
  validate(parsed) {
    return {
      subRowId: typeof parsed?.subRowId === "string" && parsed.subRowId.trim() ? parsed.subRowId.trim() : DEFAULT_CONFIG.subRowId,
      wheelFirstStepPx: posNum(parsed?.wheelFirstStepPx, DEFAULT_CONFIG.wheelFirstStepPx),
      wheelRepeatStepPx: posNum(parsed?.wheelRepeatStepPx, DEFAULT_CONFIG.wheelRepeatStepPx),
      wheelDebounceMs: posNum(parsed?.wheelDebounceMs, DEFAULT_CONFIG.wheelDebounceMs, 0),
    };
  },
  home, exec, readTextFile, checking,
});
let tabConfig = { ...DEFAULT_CONFIG };
const mountConfig = (view, cx) => modConfig.mount(view, cx, {
  watchFolder,
  shown: () => shownIn(layout(), "hj-tabs"),
  onConfig({ config }) { tabConfig = config; },
  onChange(_result, cx) { cx.notify(); },
});

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Same as the agents mod: drops a status glyph, keeps a leading bracket or quote.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

// A tab Herdr named (unnamed, or after its program) follows its agent's live
// title, as the agents list does; a name the person gave stays.
function label(tab, lead) {
  const prog = lead?.program?.name;
  const base = tab.named ? tab.name : prog ?? "Terminal";
  if (!lead?.program?.agent) return base;
  const live = clean(lead.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== lead.terminal && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== lead.program.key;
  return (tab.name === prog || !tab.named) && telling ? live : base;
}

// Who is whose sub-tab: for each sub-tab, its top super tab and the address of
// the terminal its first pane answers to. A super is in the same space.
function families(all, terms, spaceOf) {
  const parent = new Map(terms.map((k) => [k.address, k.parent]));
  const tabOf = new Map(), first = new Map();
  for (const p of all) {
    if (!first.has(p.tab)) first.set(p.tab, p);
    if (p.terminal) tabOf.set(p.terminal, p.tab);
  }
  const above = new Map(), boss = new Map();
  for (const [tab, p] of first) {
    const space = spaceOf.get(tab);
    if (!p.terminal || !space) continue;
    const seen = new Set([p.terminal]);
    // A parked parent has no pane, but its parent can still be the super.
    for (let up = parent.get(p.terminal); up && !seen.has(up); up = parent.get(up)) {
      seen.add(up);
      const home = tabOf.get(up);
      if (!home || home === tab || spaceOf.get(home) !== space) continue;
      above.set(tab, home);
      boss.set(tab, up);
      break;
    }
  }
  const top = new Map();
  for (const id of above.keys()) {
    let at = id;
    const seen = new Set();
    while (above.has(at) && !seen.has(at)) { seen.add(at); at = above.get(at); }
    // A loop has no top: its tabs stay in the bar.
    if (!above.has(at)) top.set(id, at);
  }
  return { top, boss, tabOf, parent };
}

// Sub-agents a pane was asked for, until it shows: address -> { tab, top }.
// Module state, so the copies of the bar never ask twice.
const asked = new Map();
// How often `hc label` failed for a sub-agent: after two, it is left without a pane.
const failed = new Map();
const PLACED = "hj.sub";

// The `hc label` calls that give each live sub-agent without a pane its place:
// the half-full sub-tab of its super's tab, or a new one. The app shows a
// terminal in the tab its labels name. A parked sub-agent keeps the PLACED
// label, which leaves it parked.
function placements(all, terms, sps, fam) {
  const local = new Map();
  for (const space of sps) if (!space.machine) for (const tab of space.tabs) local.set(tab.id, space.id);
  const count = new Map();
  for (const p of all) count.set(p.tab, (count.get(p.tab) ?? 0) + 1);
  const live = new Set(terms.filter((k) => k.state === "live").map((k) => k.address));
  for (const [address, want] of asked) {
    if (fam.tabOf.has(address) || !live.has(address)) asked.delete(address);
    else count.set(want.tab, (count.get(want.tab) ?? 0) + 1);
  }
  const jobs = [];
  for (const k of terms) {
    if (!k.parent || k.state !== "live" || k.address.includes("/") || k.labels?.[PLACED]) continue;
    if (fam.tabOf.has(k.address) || asked.has(k.address) || failed.get(k.address) >= 2) continue;
    // Its nearest ancestor with a pane, or with one on the way, names the family.
    let home = null;
    const seen = new Set();
    for (let up = k.parent; up && !seen.has(up) && !home; up = fam.parent.get(up)) {
      seen.add(up);
      home = fam.tabOf.get(up) ?? asked.get(up)?.top ?? null;
    }
    const top = home ? fam.top.get(home) ?? home : null;
    const space = top ? local.get(top) : null;
    if (!space) continue;
    let tab = null;
    for (const [sub, its] of fam.top) if (its === top && count.get(sub) === 1) { tab = sub; break; }
    if (!tab) for (const want of asked.values()) if (want.top === top && count.get(want.tab) === 1) { tab = want.tab; break; }
    tab ??= "tb" + Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    asked.set(k.address, { tab, top });
    count.set(tab, (count.get(tab) ?? 0) + 1);
    jobs.push(["label", k.address, `herdr.space=${space}`, `herdr.tab=${tab}`, `${PLACED}=${top}`]);
  }
  return jobs;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    try { this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}"); } catch { this.panels = {}; }
    if (!this.panels || typeof this.panels !== "object" || Array.isArray(this.panels)) this.panels = {};
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
    mountConfig(this, cx);
  }

  close() {
    modConfig.unmount(this);
  }

  // One tab per wheel notch. A touchpad or smooth-scrolling mouse sends many
  // small events per gesture: a short swipe or one smoothed notch (about
  // 25 px) switches one tab, a longer swipe keeps going a tab per 60 px, at
  // most one every 100 ms so each shows.
  wheel(e) {
    if (e.delta_lines) {
      if (e.delta_lines.y) run(e.delta_lines.y > 0 ? "tab.prev" : "tab.next");
      return;
    }
    const s = this.swipe, now = Date.now();
    // Phases often arrive only as moves (a macOS touchpad included): a pause
    // or a turn starts a new gesture.
    if (e.touch_phase === "started" || now - s.at > 250 || e.delta.y * s.acc < 0) Object.assign(s, { acc: 0, steps: 0 });
    s.at = now;
    s.acc += e.delta.y;
    const need = s.steps ? tabConfig.wheelRepeatStepPx : tabConfig.wheelFirstStepPx;
    if (Math.abs(s.acc) < need || now - s.last < tabConfig.wheelDebounceMs) return;
    s.acc -= Math.sign(s.acc) * need;
    s.steps++;
    s.last = now;
    run(e.delta.y > 0 ? "tab.prev" : "tab.next");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  // The row of sub-tabs shows only for a tab that has them, or is one.
  syncSubRow(row, want) {
    if (!row) return;
    if (!row.hidden === want) { this.subAsked = null; return; }
    // Asked already: the layout catches up a moment later.
    if (this.subAsked?.want === want && Date.now() - this.subAsked.at < 1000) return;
    this.subAsked = { want, at: Date.now() };
    run(want ? "layout.show" : "layout.hide", { id: tabConfig.subRowId });
  }

  // The second row: "super", then the sub-tabs of the shown tab's family.
  renderSub(t, space, fam, all, terms) {
    const tabs = space?.tabs ?? [];
    const current = tabs.find((tab) => tab.active);
    const superId = current ? fam.top.get(current.id) ?? current.id : null;
    const subs = tabs.filter((tab) => fam.top.get(tab.id) === superId);
    const names = new Map(terms.map((k) => [k.address, k.name || k.address]));
    const stop = (_e, cx) => cx.stop_propagation();
    const pill = (tab, name, on, addr) => h_flex().id(`sub-${tab.id}`).h(25).px(9).gap(6).rounded(6).items_center().flex_none().text_size(12.2)
      .border(1).border_color(on ? t.border : t.chrome).bg(on ? t.raised : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover(s => s.bg(t.hover))
      .on_mouse_down("left", stop)
      .on_click(() => run("tab.select", { id: tab.id }))
      .when(Boolean(addr), el => el.child(div().flex_none().text_size(10.5).text_color(t.muted + "a6").child(addr)))
      .child(div().max_w(260).truncate().child(name))
      .when(tab.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900)))
      .when(tab.status === "blocked" || tab.status === "done", el => el.child(div().size(6).rounded(3).bg(t[tab.status])));
    const sub = (tab) => {
      const boss = fam.boss.get(tab.id);
      const base = tab.named ? tab.name : all.filter((p) => p.tab === tab.id && p.terminal).map((p) => names.get(p.terminal) ?? p.terminal).join(" | ");
      // The super's address reads as a quiet prefix, apart from the name.
      const name = base.startsWith(`${boss} - `) ? base.slice(boss.length + 3) : base.startsWith(`${boss} `) ? base.slice(boss.length + 1) : base;
      return pill(tab, name, tab.active, boss)
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: tab.id, space: space.id } } }); })
        .when(tab.active, el => el.child(div().id(`sub-close-${tab.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: tab.id }); }).child(svg("mods/pane/close.svg").size(11))));
    };
    const top = tabs.find((tab) => tab.id === superId);
    return h_flex().id("sub-scroll").size_full().min_w(0).px(10).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border).overflow_x_scrollbar()
      .when(Boolean(top) && subs.length > 0, el => el.child(pill(top, "super", top.active).font_medium()).children(subs.map(sub)));
  }

  render(cx) {
    modConfig.wake(this, cx);
    const t = theme();
    // One read of each live list per render.
    const sps = spaces(), all = panes(), terms = terminals();
    const space = sps.find(p => p.active);
    const root = layout(), subRow = find(root, tabConfig.subRowId);
    const spaceOf = new Map();
    for (const s of sps) for (const tab of s.tabs) spaceOf.set(tab.id, s.id);
    // Without the second row in this layout, every tab stays in the bar.
    const fam = subRow ? families(all, terms, spaceOf) : { top: new Map(), boss: new Map() };
    if (props()?.row === "sub") return this.renderSub(t, space, fam, all, terms);
    if (subRow && !checking()) {
      const jobs = placements(all, terms, sps, fam);
      // After this render: a program may not start during one.
      if (jobs.length) cx.spawn(async (cx) => {
        await cx.sleep(0);
        for (const job of jobs) {
          const out = await hc(job).catch((e) => ({ code: -1, stderr: e.message }));
          if (out.code === 0) continue;
          // Its place is free again, and a later render asks once more.
          console.error(`hj-tabs: hc label ${job[1]}: ${out.stderr.trim()}`);
          asked.delete(job[1]);
          failed.set(job[1], (failed.get(job[1]) ?? 0) + 1);
        }
      });
    }
    const leads = new Map();
    for (const p of all) {
      const lead = leads.get(p.tab);
      if (!lead || (p.program?.agent && !lead.program?.agent)) leads.set(p.tab, p);
    }
    const shown = (space?.tabs ?? []).filter(tab => !fam.top.has(tab.id));
    const current = space?.tabs.find(tab => tab.active);
    const lit = current ? fam.top.get(current.id) ?? current.id : null;
    this.syncSubRow(subRow, Boolean(current) && [...fam.top.values()].includes(lit));
    const active = shown.findIndex(tab => tab.id === lit);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const lead = leads.get(c.id);
      const program = lead?.program;
      const name = label(c, lead);
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(c.id === lit ? t.border : t.chrome).bg(c.id === lit ? t.raised : t.chrome).text_color(c.id === lit ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    const hasTeams = Boolean(find(root, "teams"));
    const panelIds = hasTeams && !enabled.includes("teams") ? [...enabled, "teams"] : enabled;
    this.syncPanel(space, panel, body, panelIds);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => this.wheel(e))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(hasTeams, el => el.child(panelButton("teams", "Teams", "mods/workspace-chrome/layers.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
