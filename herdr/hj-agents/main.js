// Cloned from "agents" in herdr-app 0.1.16. Sub-agents take the keyboard
// in their pane even without a reported status. Server URLs follow the terminal
// that owns them, or the space they were started in for detached processes.
// To show standalone servers separately, add this below Agents in sidebar-lists:
//   { "id": "servers", "type": "block", "hidden": true, "size": { "px": 30 },
//     "content": { "mod": "hj-agents", "props": { "view": "servers" } } }
// Without the block, standalone servers stay in the Agents list.

// Agents in grouped or priority views; parents take their most urgent sub-agent's place.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, checking, exec, home, readTextFile, watchFolder } from "herdr";
import { buildAgentRows, buildShellServerGroups, countServerRows, openUrlCommand, shortUrl } from "./model.js";
// Copied from herdr/lib/mod-config.js by `just herdr-mods`.
import { createModConfig, expandHome, posInt } from "./mod-config.js";
import { shownIn } from "./shown.js";

const DEFAULT_CONFIG = {
  serverPollMs: 12000,
  serverRefreshMs: 2000,
  narrowSidebarPx: 160,
  serversEnabled: true,
  hcTeamBin: null,
};
const modConfig = createModConfig({
  mod: "hj-agents",
  envVars: ["HERDR_MOD_HJ_AGENTS_DIR"],
  defaults: DEFAULT_CONFIG,
  validate(parsed) {
    return {
      serverPollMs: posInt(parsed?.serverPollMs, DEFAULT_CONFIG.serverPollMs, 2000),
      serverRefreshMs: posInt(parsed?.serverRefreshMs, DEFAULT_CONFIG.serverRefreshMs, 500),
      narrowSidebarPx: posInt(parsed?.narrowSidebarPx, DEFAULT_CONFIG.narrowSidebarPx, 44),
      serversEnabled: typeof parsed?.serversEnabled === "boolean" ? parsed.serversEnabled : DEFAULT_CONFIG.serversEnabled,
      hcTeamBin: typeof parsed?.hcTeamBin === "string" && parsed.hcTeamBin.trim() ? parsed.hcTeamBin.trim() : null,
    };
  },
  home, exec, readTextFile, checking,
});
let agentsConfig = { ...DEFAULT_CONFIG };
const mountConfig = (view, cx) => modConfig.mount(view, cx, {
  watchFolder,
  shown: () => shownIn(layout(), "hj-agents"),
  onConfig({ config }) { agentsConfig = config; },
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

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < agentsConfig.narrowSidebarPx;

const SERVER_HEADER_PX = 30, SERVER_ROW_PX = 23, SERVER_BODY_PADDING = 4;
let snapshot = { byTerminal: {}, detached: [] }, snapshotVersion = 0;
let rawJson = "", inFlight = false, lastPollAt = 0, backoffUntil = 0;
let latestTerminalKey = null, scannedTerminalKey = null;

function pollAllowed(now = Date.now()) {
  return agentsConfig.serversEnabled && !checking() && now >= backoffUntil && !narrow() && window()?.active !== false;
}

async function pollServers(cx) {
  const now = Date.now();
  if (inFlight || now - lastPollAt < agentsConfig.serverRefreshMs || !pollAllowed(now)) return;
  inFlight = true;
  lastPollAt = now;
  scannedTerminalKey = latestTerminalKey;
  try {
    const args = ["servers", "--json"];
    // A space's configured folder need not contain any terminal's current cwd.
    // Pass it so the scanner doesn't filter out detached listeners we can place.
    const folders = spaces().filter((s) => !s.machine && s.folder).map((s) => s.folder);
    if (folders.length) args.push("--spaces", JSON.stringify([...new Set(folders)]));
    const commands = [
      ...(agentsConfig.hcTeamBin ? [expandHome(agentsConfig.hcTeamBin, home())] : []),
      "hc-team",
      `${home()}/.local/bin/hc-team`,
    ];
    for (const command of commands) {
      let stdout, next;
      try {
        const result = await exec(command, args, { timeout: 5000 });
        if (result.code !== 0) continue;
        stdout = result.stdout;
        if (stdout === rawJson) return;
        const { byTerminal, detached } = JSON.parse(stdout);
        if (!byTerminal || typeof byTerminal !== "object" || Array.isArray(byTerminal) || !Array.isArray(detached)) continue;
        next = { byTerminal, detached };
      } catch { continue; }
      rawJson = stdout;
      // updatedAt can change on every scan without changing any rows.
      if (JSON.stringify(next) !== JSON.stringify(snapshot)) {
        snapshot = next;
        snapshotVersion++;
        cx.notify();
      }
      return;
    }
    backoffUntil = Date.now() + 60000;
  } finally {
    inFlight = false;
  }
}

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

// Drops what an agent puts before its title: a status glyph or spinner and the separator
// after it ("✦  Working", "⠋ - Thinking"), and Codex's blinking "[ ! ] " / "[ . ] " mark.
// Stops at an opening bracket or quote, so a title that starts with one ("[web] login") keeps it.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    // First agent, else first focused terminal, else first terminal in the tab.
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((l?.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== (l?.terminal ?? l?.address) && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function treeLines(t, lines, height) {
  return lines.map((line) => div().w(9).h(height).mr(4).flex_none().self_start()
    .when(line === "│" || line === "├", (el) => el.border_l(1.5).border_color(t.input))
    .when(line === "├", (el) => el.child(div().h(height / 2).border_b(1.5).border_color(t.input)))
    .when(line === "└", (el) => el.child(div().h(height / 2).border_l(1.5).border_b(1.5).rounded_bl(6).border_color(t.input))));
}

function focusTerminal(terminal) {
  const inPane = panes().some((p) => p.terminal === terminal);
  run(inPane ? "pane.focus" : "terminal.peek", { terminal });
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    this.expandedServers = new Set();
    if (props()?.view === "servers") {
      if (checking()) return;
      mountConfig(this, cx);
      this.wake(cx);
      return;
    }
    this.folded = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    try { this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}"); } catch { this.changed = {}; }
    if (!this.changed || typeof this.changed !== "object" || Array.isArray(this.changed)) this.changed = {};
    try { this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]"); } catch { this.pendingPins = []; }
    if (!Array.isArray(this.pendingPins)) this.pendingPins = [];
    if (checking()) return;
    mountConfig(this, cx);
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    this.wake(cx);
  }

  // Timers run only while this copy's block is shown: one that fires hidden ends there, and the
  // render that shows the block again starts it. A hidden sidebar costs no scan and no repaint.
  wake(cx) {
    if (checking() || props()?.sortMenu) return;
    modConfig.wake(this, cx);
    const servers = props()?.view === "servers";
    const shown = () => shownIn(layout(), "hj-agents", (p) => (p?.view === "servers") === servers);
    if (!this.serverTimer) {
      this.serverTimer = cx.timer.after(servers ? agentsConfig.serverRefreshMs : agentsConfig.serverPollMs, (cx) => {
        this.serverTimer = null;
        if (!shown()) return;
        if (!servers) {
          if (pollAllowed()) cx.spawn(pollServers);
        } else {
          if (this.seenVersion !== snapshotVersion || this.seenFolded !== Boolean(shared("servers.folded"))) cx.notify();
          // Normally Agents scans. A standalone Servers copy can bootstrap the snapshot.
          if (snapshotVersion === 0 && pollAllowed() && Date.now() - lastPollAt >= agentsConfig.serverPollMs) cx.spawn(pollServers);
        }
        this.wake(cx);
      });
    }
    // Durations ("3m") age between events: redraw them twice a minute.
    if (!servers && !this.clock) {
      this.clock = cx.timer.after(30000, (cx) => {
        this.clock = null;
        if (shown()) { cx.notify(); this.wake(cx); }
      });
    }
  }

  close() {
    this.serverTimer?.cancel?.();
    this.clock?.cancel?.();
    modConfig.unmount(this);
  }

  refreshOnTerminalChange(cx, list, all) {
    // Ignore cursor, selection, and title updates: they don't change the scan.
    latestTerminalKey = JSON.stringify([
      list.map((a) => [a.address, a.status]),
      all.map((t) => [t.address, t.state, t.pid, t.parent, t.cwd, t.status, t.labels?.["hj.url"], t.labels?.["hj.urls"]]),
    ]);
    if (latestTerminalKey === scannedTerminalKey || this.serverRefreshQueued || !pollAllowed()) return;
    this.serverRefreshQueued = true;
    cx.spawn(async (cx) => {
      try {
        // Start after the render, and coalesce changes that arrive during a scan.
        do {
          await cx.sleep(Math.max(inFlight ? 250 : 0, lastPollAt + agentsConfig.serverRefreshMs - Date.now()));
        } while (pollAllowed() && latestTerminalKey !== scannedTerminalKey && (inFlight || Date.now() - lastPollAt < agentsConfig.serverRefreshMs));
      } finally {
        this.serverRefreshQueued = false;
      }
      if (latestTerminalKey !== scannedTerminalKey) await pollServers(cx);
    });
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  rank(a) {
    return RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  serverRow(t, row, height = 21) {
    const base = h_flex().pl(39).pr(8).h(height).flex_none().rounded(6).items_center()
      .text_size(11).text_color(t.muted).cursor_pointer().hover((el) => el.bg(t.hover).text_color(t.foreground))
      .children(treeLines(t, row.lines, height));
    if (row.kind === "more") return base.id(`srv-more-${row.ownerKey}`)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.expandedServers.add(row.ownerKey);
        cx.notify();
      })
      .child(`+${row.remaining} more`);

    const { ownerKey, ownerAddr, srv } = row;
    const ownerId = ownerAddr ?? `${ownerKey}-${srv.pid}`;
    const url = shortUrl(srv.url);
    const link = base.id(`srv-${ownerId}-${srv.port}`).tooltip(url)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (checking() || !/^https?:\/\/[^\s]+$/i.test(url)) return;
        const platform = window()?.platform;
        // cmd.exe interprets shell syntax even though exec takes an argv array.
        if (platform === "windows" && /[&|<>()^%!"\\]/.test(url)) return cx.open_url(url);
        const { cmd, args } = openUrlCommand(platform, url);
        exec(cmd, args).catch((e) => console.warn(`hj-agents: could not open server URL: ${e.message}`));
      })
      .child(div().size(5).flex_none().rounded(3).mr(6).bg(t.done))
      .child(div().flex_1().min_w(0).truncate().child(url))
      .when(Boolean(ownerAddr), (el) => el.child(div().id(`srv-focus-${ownerId}-${srv.port}`).ml(4).size(17).flex_none()
        .flex().items_center().justify_center().rounded(4).text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(t.raised).text_color(t.foreground)).tooltip("Focus server terminal")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          focusTerminal(ownerAddr);
        })
        .child(svg("mods/workspace-chrome/terminal.svg").size(11))));
    // hj.urls can advertise several names for the same terminal and port.
    return v_flex().flex_none().id(`srv-link-${ownerId}-${srv.url}`).child(link);
  }

  shellRows(t, group, showSpace, rowHeight) {
    return group.owners.flatMap((owner) => [
      div().id(`srv-owner-${owner.ownerKey}`).pl(26).pr(8).h(rowHeight ?? 22).flex_none().flex().items_center()
        .text_size(12).text_color(t.muted)
        .child(div().min_w(0).truncate().child(showSpace && group.space?.name ? `${owner.label} · ${group.space.name}` : owner.label)),
      ...owner.rows.map((row) => this.serverRow(t, row, rowHeight)),
    ]);
  }

  // Only Agents can reveal a Servers block that hasn't been mounted yet.
  syncServersBlock(block, shellGroups, collapsed) {
    const show = !collapsed && shellGroups.length > 0;
    const px = !show ? null : shared("servers.folded") ? SERVER_HEADER_PX
      : Math.min(220, SERVER_HEADER_PX + SERVER_BODY_PADDING + countServerRows(shellGroups) * SERVER_ROW_PX);
    const visibilityChanged = !block.hidden !== show;
    const sizeChanged = show && block.size?.px !== px;
    if (!visibilityChanged && !sizeChanged) { this.serversAsked = null; return; }
    const now = Date.now();
    if (this.serversAsked?.px === px && now - this.serversAsked.at < 1000) return;
    this.serversAsked = { px, at: now };
    if (visibilityChanged) run(show ? "layout.show" : "layout.hide", { id: "servers" });
    if (sizeChanged) run("layout.resize", { id: "servers", px });
  }

  renderServers(t) {
    const folded = Boolean(shared("servers.folded"));
    this.seenVersion = snapshotVersion;
    this.seenFolded = folded;
    // The block scrolls, so it can show every URL without per-owner expand state.
    const groups = buildShellServerGroups(terminals(), agents().map((a) => a.address), spaces(), snapshot.byTerminal, snapshot.detached, this.expandedServers, Infinity);
    const total = groups.reduce((n, g) => n + g.owners.reduce((rows, owner) => rows + owner.rows.length, 0), 0);
    return v_flex().size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border)
      .child(h_flex().id("servers-fold").px(16).h(SERVER_HEADER_PX - 1).gap(6).flex_none().items_center()
        .text_size(11.5).font_medium().text_color(t.muted).cursor_pointer()
        .hover((el) => el.bg(t.hover).text_color(t.foreground))
        .tooltip(folded ? "Expand servers" : "Collapse servers")
        .on_click(() => setShared("servers.folded", !folded))
        .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none())
        .child("Servers")
        .child(div().text_color(t.dim).child(String(total))))
      .when(!folded, (el) => el.child(v_flex().id("servers-list").flex_1().min_h(0).px(8).pb(SERVER_BODY_PADDING)
        .overflow_y_scrollbar().children(groups.flatMap((g) => [
          h_flex().id(`servers-space-${g.space?.id ?? "unassigned"}`).px(8).h(SERVER_ROW_PX).flex_none().items_center()
            .text_size(11).font_medium().text_color(t.dim)
            .child(div().min_w(0).truncate().child(g.space?.name || g.space?.id || "No space")),
          ...this.shellRows(t, g, false, SERVER_ROW_PX),
        ]))));
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => focusTerminal(k.address))
      .children(treeLines(t, s.lines, 26))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    this.wake(cx);
    if (props()?.view === "servers") return this.renderServers(t);
    const collapsed = narrow();
    const sort = sortOf();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    const shown = focused()?.agent;
    const now = Date.now();
    if (!checking()) {
      if (!collapsed) this.refreshOnTerminalChange(cx, list, all);
      this.migratePins(all);
      this.track(list, now);
    }
    // A kept sub-agent (one with a pane) is in agents() too: where a tree shows
    // it, it gets no row of its own, unless it's pinned.
    const trees = new Map(list.map((a) => [a.address, buildAgentRows(a.address, all, snapshot.byTerminal, this.expandedServers)]));
    const subsByAgent = new Map([...trees].map(([addr, rows]) => [addr, rows.filter((row) => row.kind === "sub")]));
    const nested = new Set(collapsed ? [] : [...subsByAgent.values()].flatMap((subs) => subs.map((s) => s.t.address)));
    list = list.filter((a) => a.pinned || !nested.has(a.address));
    const tabCounts = new Map();
    for (const a of list) tabCounts.set(a.tab, (tabCounts.get(a.tab) ?? 0) + 1);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...subsByAgent.get(a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));

    const withKids = (a, i) => {
      const children = collapsed ? [] : trees.get(a.address);
      const r = row(a, i, subsByAgent.get(a.address), children.length > 0);
      if (this.folded.has(a.address) || !children.length) return r;
      return v_flex().id(`ag-tree-${a.address}`).flex_none().child(r)
        .children(children.map((s) => s.kind === "sub" ? this.subRow(t, s, shown, byPriority) : this.serverRow(t, s)));
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open && subs.length > 0, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    // Read the pane snapshot once: every host read copies the whole list into JS.
    const leads = leadPanes(panes());
    const allSpaces = spaces();
    const tabs = new Map(allSpaces.flatMap(s => s.tabs).map(tab => [tab.id, tab]));
    const serversBlock = find(layout(), "servers");
    const standalone = collapsed ? [] : buildShellServerGroups(all, this.listed.keys(), allSpaces, snapshot.byTerminal, snapshot.detached, this.expandedServers, serversBlock ? Infinity : undefined);
    if (serversBlock && !checking()) this.syncServersBlock(serversBlock, standalone, collapsed);
    const shellGroups = serversBlock ? [] : standalone;
    const labels = new Map(list.map(a => {
      const tab = tabs.get(a.tab);
      const many = tabCounts.get(a.tab) > 1;
      return [a.address, tab ? title(many ? { ...tab, named: false } : tab, many ? a : leads.get(a.tab)) : (a.title || a.program?.name || "")];
    }));
    const label = (a) => labels.get(a.address);
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const row = (a, i, subs, hasChildren) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || isPinned;
      const name = full ? a.space_name || label(a) : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      return h_flex()
        .id(`ag-${a.address}`)
        .px(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .when(a.focused, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(hasChildren, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).max_w(full && more ? 120 : 200).truncate().text_color(idle ? t.muted : t.foreground).child(name))
          .when(full && Boolean(more), el => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`\u00b7 ${more}`))))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(hasChildren, el => el.child(fold(a, subs)))
        .when(this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.status(t, a, byPriority && !isPinned));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    if (shellGroups.length && byPriority) {
      groups.push({ id: "shell-servers", label: "Shell Servers", members: [], shells: shellGroups });
    } else for (const g of shellGroups) {
      const matching = g.space && groups.find((group) => group.id === `sp-${g.space.id}`);
      if (matching) matching.shells = [g];
      else groups.push({
        id: g.space ? `shell-servers-${g.space.id}` : "shell-servers",
        label: g.space?.name ? `Shell Servers · ${g.space.name}` : "Shell Servers",
        members: [],
        shells: [g],
      });
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        .when(g.members.length > 0 && (byPriority || !open), (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    const rows = collapsed ? list.map(withKids) : groups.flatMap((g) => [
      header(g),
      ...(this.folded.has(g.id) ? [] : [
        ...g.members.map(withKids),
        ...(g.shells ?? []).flatMap((group) => this.shellRows(t, group, byPriority)),
      ]),
    ]);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "hj-agents", kind: "popup", width: 200, height: 140, props: { sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
            ),
        ),
      )
      .when(list.length === 0 && shellGroups.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
