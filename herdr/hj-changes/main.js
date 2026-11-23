import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, agents, focused, exec, hc, home, checking, window, layout, readTextFile, watchFolder, theme, settings, openOverlay } from "herdr";
import { MAIN, projectSlug, parseSession, parseMeta, shortLabels, promptWorktree, parseWorktreeList, worktreeTargets, visibleTargets, pickTarget, countEntries } from "./model.js";
// Copied from herdr/lib/mod-config.js by `just herdr-mods`.
import { createModConfig, expandHome, posInt } from "./mod-config.js";
import { shownIn } from "./shown.js";

const DEFAULT_CONFIG = {
  pollMs: 10000,
  maxWorktrees: 8,
  statusJobs: 4,
  claudeDir: null,
  menuMod: "hj-menu",
  reviewMod: "hj-review",
};
const modConfig = createModConfig({
  mod: "hj-changes",
  envVars: ["HERDR_MOD_HJ_CHANGES_DIR"],
  defaults: DEFAULT_CONFIG,
  validate(parsed) {
    return {
      pollMs: posInt(parsed?.pollMs, DEFAULT_CONFIG.pollMs, 1000),
      maxWorktrees: posInt(parsed?.maxWorktrees, DEFAULT_CONFIG.maxWorktrees, 1),
      statusJobs: posInt(parsed?.statusJobs, DEFAULT_CONFIG.statusJobs, 1),
      claudeDir: typeof parsed?.claudeDir === "string" && parsed.claudeDir.trim() ? parsed.claudeDir.trim() : null,
      menuMod: typeof parsed?.menuMod === "string" && parsed.menuMod.trim() ? parsed.menuMod.trim() : DEFAULT_CONFIG.menuMod,
      reviewMod: typeof parsed?.reviewMod === "string" && parsed.reviewMod.trim() ? parsed.reviewMod.trim() : DEFAULT_CONFIG.reviewMod,
    };
  },
  home, exec, readTextFile, checking,
});
let changesConfig = { ...DEFAULT_CONFIG };
const mountConfig = (view, cx) => modConfig.mount(view, cx, {
  watchFolder,
  shown: () => shownIn(layout(), "hj-changes"),
  onConfig({ config }) { changesConfig = config; },
  onChange(_result, cx) { cx.notify(); },
});

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  // The terminal is in the key so two sessions in one folder don't share worktree targets.
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, terminal: f?.shown || pane?.terminal || f?.terminal || null };
}
const key = () => JSON.stringify(location());
const claudeDir = () => changesConfig.claudeDir ? expandHome(changesConfig.claudeDir, home()) : `${home()}/.claude`;
// The agent app a terminal runs ("claude-code", "pi", …), or null for a shell.
const appOf = (terminal) => panes().find((p) => p.terminal === terminal)?.app ?? agents().find((a) => a.address === terminal)?.app ?? null;
const isClaude = (terminal) => appOf(terminal) === "claude-code";
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one. A path is a path,
// not a pattern (`[id].tsx`).
const READ = ["--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const STATUS = ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"];
const PROMPT_CHARS = 20000;
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Text elements draw Geist Mono's programming ligatures (`...`, `??`, `=>`) at the wrong width,
// covering the next cells: a zero-width non-joiner between punctuation marks keeps them apart.
// The same as hj-review's model.js `unligature`.
const unligature = (text) => text.replace(/([!-/:-@[-`{-~])(?=[!-/:-@[-`{-~])/g, "$1\u200c");

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    // Worktree targets of the focused Claude session: subagents started with worktree isolation.
    this.targets = []; this.selected = MAIN; this.mainCount = null; this.session = null;
    this.picks = new Map(); this.sessions = new Map(); this.metas = new Map(); this.found = new Map();
    if (checking()) return;
    mountConfig(this, cx);
    this.refresh(cx);
    this.poll(cx);
  }

  // A tick while a load runs is dropped, not queued: a slow repo must not keep the panel loading.
  // A tick that finds the panel hidden ends the timer; the render that shows it starts it again.
  poll(cx) {
    this.pollTimer = cx.timer.after(changesConfig.pollMs, (cx) => {
      this.pollTimer = null;
      if (window()?.active !== false && !this.loading && !this.busy) this.refresh(cx);
      if (!this.stale) this.poll(cx);
    });
  }

  close() {
    this.pollTimer?.cancel?.();
    this.unwatch();
    modConfig.unmount(this);
    this.input.release();
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.unwatch();
    // A token, not the root: a cancelled loop wakes later and must not resume when the same root is watched again.
    const token = this.watchToken = {};
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watchToken === token) {
          this.watching = watchFolder(root);
          await this.watching;
          if (this.watchToken === token) this.refresh(cx, false);
        }
      } catch { if (this.watchToken === token) this.watched = this.watchToken = null; }
    });
  }

  unwatch() {
    this.watched = this.watchToken = null; this.watching?.cancel(); this.watching = null;
  }

  // The session behind the focused Claude terminal, and its subagents' worktrees that still exist.
  // Throws when a lookup fails, so the caller keeps what it shows instead of dropping the targets.
  async discover(terminal) {
    const claude = claudeDir();
    let pid = null;
    try { pid = JSON.parse((await hc(["get", terminal, "--json"])).stdout)?.foreground?.pid ?? null; } catch {}
    let session = pid ? parseSession(await readTextFile(`${claude}/sessions/${pid}.json`).catch(() => null)) : null;
    // A `!` command inside Claude is the foreground for a moment: keep the last session.
    if (session) this.sessions.set(terminal, session); else session = this.sessions.get(terminal) ?? null;
    if (!session) return null;
    // Claude names the project folder by slug; for a folder it names otherwise, find the session's
    // transcript once. Only a hit is kept: the transcript may not exist yet.
    let project = `${claude}/projects/${projectSlug(session.cwd)}`;
    if ((await exec("test", ["-d", project])).code !== 0) {
      if (!this.found.has(session.sessionId)) {
        const r = await exec("find", [`${claude}/projects`, "-mindepth", "2", "-maxdepth", "2", "-name", `${session.sessionId}.jsonl`]);
        const hit = r.code === 0 ? r.stdout.split("\n").find(Boolean) : null;
        if (hit) this.found.set(session.sessionId, hit.slice(0, hit.lastIndexOf("/")));
      }
      project = this.found.get(session.sessionId);
      if (!project) return { session, visible: [], mainCount: null };
    }
    const dir = `${project}/${session.sessionId}/subagents`, metas = [];
    // No folder yet means no subagents yet.
    const ls = await exec("ls", ["-t", dir]);
    for (const name of ls.code === 0 ? ls.stdout.split("\n") : []) {
      if (!name.endsWith(".meta.json")) continue;
      const path = `${dir}/${name}`;
      // Finished metas and team members' don't change; a running one gets `finished` when it ends,
      // and an unreadable one (undefined) is read again.
      let meta = this.metas.get(path);
      if (meta === undefined || meta?.running) {
        meta = parseMeta(name, await readTextFile(path).catch(() => null));
        // Without a worktree of its own, a subagent may be sent to one: its prompt, the transcript's first line, names it.
        if (meta && !meta.path) {
          const r = await exec("head", ["-n", "1", path.replace(/\.meta\.json$/, ".jsonl")]).catch(() => null);
          meta.prompt = r?.code === 0 ? r.stdout.slice(0, PROMPT_CHARS) : "";
        }
        // A prompt not written yet is read again.
        this.metas.set(path, meta && !meta.path && !meta.prompt ? undefined : meta);
      }
      if (meta) metas.push(meta);
    }
    if (!metas.length) return { session, visible: [], mainCount: null };
    const list = await exec("git", [...READ, "worktree", "list", "--porcelain"], { cwd: session.cwd });
    if (list.code !== 0) throw new Error(list.stderr);
    const worktrees = parseWorktreeList(list.stdout);
    // The session's own checkout is `main`, never a target.
    const others = [...worktrees.keys()].filter((p) => p !== session.cwd && !session.cwd.startsWith(`${p}/`));
    const targets = worktreeTargets(metas.map((m) => m.path ? m : { ...m, path: promptWorktree(m.prompt, others) }), worktrees);
    const count = async (folder) => {
      const r = await exec("git", [...READ, ...STATUS], { cwd: folder }).catch(() => null);
      return r?.code === 0 ? countEntries(r.stdout) : null;
    };
    // Every live worktree is counted (a running one may be the oldest), a few `git status` at a time.
    const counts = {};
    let next = 0;
    const worker = async () => { while (next < targets.length) { const t = targets[next++]; counts[t.path] = await count(t.path); } };
    const [mainCount] = await Promise.all([count(session.cwd), ...Array.from({ length: Math.min(changesConfig.statusJobs, targets.length) }, worker)]);
    return { session, visible: shortLabels(visibleTargets(targets, counts).slice(0, changesConfig.maxWorktrees)), mainCount };
  }

  // Shows another target: nothing from the last one (files, diff, draft message) carries over.
  switchTarget(next) {
    this.selected = next; this.root = null; this.files = []; this.open = null; this.closed = false; this.limited = false;
    this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.unwatch();
  }

  choose(id, cx) {
    if (id === this.selected) return;
    if (this.session) this.picks.set(this.session.sessionId, id);
    this.switchTarget(id);
    this.refresh(cx, false);
    cx.notify();
  }

  // `discover`: also look for the session's worktrees (focus change, timer), not only reread the shown one.
  refresh(cx, discover = true) {
    if (checking()) return;
    // A hidden panel lets go of its watch and timer: render refreshes and restarts them when it shows.
    if (!shownIn(layout(), "hj-changes")) { this.stale = true; this.unwatch(); return; }
    this.stale = false;
    if (this.loading || this.busy) { this.pending = true; this.pendingDiscover ||= discover; return; }
    const { cwd, on, terminal } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.unwatch(); this.closed = false; this.limited = false;
      this.targets = []; this.selected = MAIN; this.mainCount = null; this.session = null; discover = true;
    }
    if (!cwd) return;
    this.loading = true;
    let selected = this.selected;
    cx.spawn(async (cx) => {
      try {
        if (discover) {
          // Local Claude terminals only: a remote one ("machine/t…") has its sessions on that machine.
          const claude = !on && terminal && !terminal.includes("/") && isClaude(terminal);
          // undefined: the lookup failed, so the targets shown stay; null: no session.
          const found = claude ? await this.discover(terminal).catch(() => undefined) : null;
          if (key() !== context) return;
          if (found !== undefined) { this.session = found?.session ?? null; this.targets = found?.visible ?? []; this.mainCount = found?.mainCount ?? null; }
          const next = pickTarget(this.targets, this.session ? this.picks.get(this.session.sessionId) : null);
          if (next !== this.selected) this.switchTarget(next);
        }
        selected = this.selected;
        // `main` is the session's own folder, which a shown terminal (terminal.show) may not share with the pane.
        const folder = selected === MAIN ? this.session?.cwd ?? cwd : selected;
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
        if (key() !== context || this.selected !== selected) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.unwatch(); this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(STATUS);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (key() !== context || this.selected !== selected) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context && this.selected === selected) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) {
        // A failed read shows the error, not the last list: the commit (`add -A`) would take changes no longer shown.
        if (key() === context && this.selected === selected) { this.root = null; this.files = []; this.open = null; this.setLines([]); this.unwatch(); this.error = String(e); }
      }
      finally {
        this.loading = false;
        if (this.pending) { const again = this.pendingDiscover; this.pending = this.pendingDiscover = false; this.refresh(cx, again); }
        cx.notify();
      }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path && this.root === root) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...this.rows.map(row => (row.text.length + 1) * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context, selected = this.selected;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.selected === selected && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  // A running subagent may still be writing its worktree: no commits there until it finishes.
  active() { return this.targets.find((t) => t.path === this.selected) ?? null; }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key() || this.active()?.running) return;
    const root = this.root, on = this.on, context = this.context, selected = this.selected, message = this.message.trim();
    // After a switch the draft and the note belong to the other target.
    const same = () => key() === context && this.selected === selected;
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (same() && this.message.trim() === message) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (same()) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // The Review window (hj-review) for a subagent worktree, against the session's checkout, with the
  // comments relayed through this session; or, with no target, for the shown checkout's uncommitted
  // changes, with the comments sent to the agent in this terminal.
  reviewOverlay(target) {
    const session = this.session, { on, terminal } = location();
    if (on || this.context !== key()) return null;
    const common = { terminal, app: terminal ? appOf(terminal) : null, claudeDir: claudeDir() };
    const props = target
      ? session && {
        ...common, root: target.path, parentCwd: session.cwd, sessionId: session.sessionId, branch: target.branch,
        agent: { id: target.agentId, to: target.name || target.agentId, label: target.label },
      }
      : this.root && { ...common, root: this.root, sessionId: session?.sessionId ?? null };
    return props ? { mod: changesConfig.reviewMod, kind: "window", key: "hj-review", width: 0.86, height: 0.86, props } : null;
  }

  // Right-click a worktree chip: Review it, or Open With.
  targetMenu(target, e, cx) {
    const review = this.reviewOverlay(target);
    if (!review) return;
    cx.stop_propagation();
    // Open With runs /usr/bin/open: elsewhere the menu would hold Review alone.
    if (window()?.platform !== "macos") return void openOverlay(review);
    const at = e.position;
    openOverlay({ mod: changesConfig.menuMod, kind: "popup", width: 160, height: 75, at,
      props: { path: target.path, origin: at, actions: [{ label: "Review", icon: `mods/${changesConfig.reviewMod}/review.svg`, overlay: review }] } });
  }

  chip(id, label, count, running, t, target = null) {
    const on = this.selected === id;
    return h_flex().id(`target-${id}`).h(24).flex_none().px(8).gap(5).items_center().rounded(6).border_1().border_color(on ? t.accent : t.border)
      .when(on, (e) => e.bg(t.selected)).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.choose(id, cx))
      .when(Boolean(target), (e) => e.tooltip("Right-click to review").on_mouse_down("right", (ev, cx) => this.targetMenu(target, ev, cx)))
      .when(running, (e) => e.child(div().w(6).h(6).flex_none().rounded_full().bg(t.ansi3)))
      .child(div().max_w(140).truncate().text_size(11).child(label))
      .when(count !== null, (e) => e.child(div().text_size(10).text_color(t.dim).child(String(count))));
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(unligature(text));
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(unligature(text)));
  }

  render(cx) {
    modConfig.wake(this, cx);
    if (key() !== this.context || this.stale) this.refresh(cx);
    if (!this.pollTimer && !checking()) this.poll(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const running = Boolean(this.active()?.running);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading && !running);
    return v_flex().id("changes").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`))
        // Reviews the shown target: the checkout's uncommitted changes, or a worktree since its merge-base.
        .when(Boolean(this.root && !this.on), (e) => e.child(div().id("changes-review").size(24).flex().flex_none().items_center().justify_center().rounded(6)
          .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(this.active() ? "Review this worktree" : "Review these changes")
          .on_click((_e, cx) => { const review = this.reviewOverlay(this.active()); if (review) openOverlay(review); })
          .child(svg(`mods/${changesConfig.reviewMod}/review.svg`).size(14).text_color(t.muted)))))
      // One chip per subagent worktree, plus the session's own checkout; shown only when there is a worktree.
      // Wrapped, not scrolled sideways: a team of 6+ would otherwise hide most chips past the panel edge.
      .when(this.targets.length > 0, (el) => el.child(h_flex().id("changes-targets").flex_none().flex_wrap().px(8).py(6).gap(6).items_center().border_b(1).border_color(t.border)
        .child(this.chip(MAIN, "main", this.mainCount, false, t))
        .children(this.targets.map((w) => this.chip(w.path, w.short, w.count, w.running, t, w)))))
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().flex_1().min_h(44).max_h(this.files.length * 28 + 12).relative().border_b(1).border_color(t.border)
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        const { root, on, context } = this;
        return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
          .on_mouse_down("right", (e, cx) => {
            const current = () => this.root === root && this.context === context && context === key();
            if (!root || on || f.status === "D" || !current() || window()?.platform !== "macos") return;
            cx.stop_propagation();
            const path = `${root}/${f.path}`, at = e.position;
            const showMenu = () => openOverlay({ mod: changesConfig.menuMod, kind: "popup", width: 160, height: 44, at, props: { path, origin: at } });
            if (f.status !== "U") showMenu();
            else cx.spawn(async () => {
              // "U" also includes delete/delete conflicts with no file on disk.
              const present = await exec("/bin/test", ["-f", path]).catch(() => null);
              if (present?.code === 0 && current()) showMenu();
            });
          })
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder")))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : running ? "Running…" : "Commit")));
  }
}
