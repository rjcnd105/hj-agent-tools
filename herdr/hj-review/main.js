// Reviews changes with no PR: comment on diff lines, then send the comments to the agent behind them.
// Opened by hj-changes with props:
// { root, terminal, app, sessionId, claudeDir, branch, parentCwd, agent: { id, to, label } }.
// - A subagent worktree (parentCwd and agent set): its changes since the merge-base with the parent
//   checkout, committed or not. The comments go to the parent Claude session, which relays them.
// - Any other checkout: its uncommitted changes since HEAD. The comments go to the agent in `terminal`.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, InputState, Input } from "gpui-base";
import { props, theme, settings, fonts, exec, hc, home, readTextFile, writeTextFile, checking, closeOverlay } from "herdr";
import { isLine, parseDiff, addedRows, parseFiles, painter, pieces, unligature, cells, wrap, range, anchor, anchorRow, moved, place, feedback } from "./model.js";
import { languageOf, spanner } from "./syntax.js";
import { Scroller } from "./scroller.js";
// Copied from herdr/lib/mod-config.js by `just herdr-mods`.
import { createModConfig } from "./mod-config.js";

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie). A path is a path,
// not a pattern (`[id].tsx`), and a blank context line keeps its leading space.
const READ = ["--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-c", "diff.suppressBlankEmpty=false"];
const DIFF = ["--no-ext-diff", "--no-textconv", "--no-color"];
const MAX_FILES = 1000, MAX_ROWS = 5000, MAX_LINE = 2000;
// Every file's diff in one scroll, items of fixed heights (metrics). Diffs load for the files within
// NEAR screens of the view, LOADS at a time.
const GAP = 12, FILE = 28, NEAR = 1.5, LOADS = 4;
// Syntax colouring parses this many rows (about 12 ms of dense code in QuickJS), then lets a frame through.
const PAINT_ROWS = 20;
const ICONS = "mods/workspace-chrome";
const HINT = "Click a line to comment · drag or shift-click for a range · ⌘-click adds a line";
// Drafts outlive the window (closing it, reviewing another target) until Herdr reloads the mod.
// One per agent session and folder; an empty one is dropped when its window closes.
const drafts = new Map();

// Settings in ~/.herdr/hj-review/config.json (HERDR_MOD_HJ_REVIEW_DIR moves it), changed from the
// title bar's gear. Read when a window opens; the window writes what it changes. The line height is
// a multiple of the font size; a null font is the app's own.
const DEFAULT_CONFIG = { codeFontSize: 13, codeLineHeight: 1.8, codeFontFamily: null };
const FONT_MIN = 9, FONT_MAX = 24, LINE_MIN = 1.2, LINE_MAX = 2.4;
const tenth = (n) => Math.round(n * 10) / 10;
// A number held to [lo, hi], or the default when it isn't a number.
const within = (value, lo, hi, fallback) => {
  const n = typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const modConfig = createModConfig({
  mod: "hj-review",
  envVars: ["HERDR_MOD_HJ_REVIEW_DIR"],
  defaults: DEFAULT_CONFIG,
  validate: (parsed) => {
    const family = parsed?.codeFontFamily;
    return {
      codeFontSize: Math.round(within(parsed?.codeFontSize, FONT_MIN, FONT_MAX, DEFAULT_CONFIG.codeFontSize)),
      codeLineHeight: tenth(within(parsed?.codeLineHeight, LINE_MIN, LINE_MAX, DEFAULT_CONFIG.codeLineHeight)),
      codeFontFamily: typeof family === "string" && family.trim() ? family.trim() : null,
    };
  },
  home, exec, readTextFile, checking,
});
// Writes go one at a time, each over what the one before wrote.
let saving = Promise.resolve();
async function saveConfig(change) {
  const dir = await modConfig.resolveDir(), path = await modConfig.resolvePath();
  // A second try when another writer got in between: the change goes over what that one wrote.
  for (let tries = 2; ; tries--) {
    const raw = await readTextFile(path), kept = raw?.trim() ? JSON.parse(raw) : {};
    // A file that isn't a JSON object is the person's to fix, not ours to overwrite.
    if (!kept || typeof kept !== "object" || Array.isArray(kept)) throw new Error(`${path} isn't a JSON object`);
    if (raw === null) {
      const made = await exec("/bin/mkdir", ["-p", dir]);
      if (made.code !== 0) throw new Error(made.stderr.trim() || `mkdir exited ${made.code}`);
    }
    try {
      await writeTextFile(path, JSON.stringify({ ...kept, ...change }, null, 2) + "\n", raw);
      return;
    } catch (e) {
      if (tries === 1) throw e;
    }
  }
}

// The diff's sizes follow its text size: a code row (its line height), a header, a comment line (a
// little under a row, never so short it clips the text), a mono character (most mono fonts are 0.6
// em; a little more keeps wrapped comments inside their box), a line number's column, the columns
// before the code, and where a comment box starts.
function metrics({ codeFontSize: size, codeLineHeight: lh }) {
  const ROW = Math.round(size * lh), BASE = Math.round(size * 1.8), COL = size * 0.64, NUM = Math.ceil(COL * 5), SIGN = Math.max(10, Math.ceil(COL));
  return { size, ROW, HEAD: BASE + 10, NOTE: BASE + 8, LINE: Math.round(size * Math.max(1.5, lh - 0.15)), COL, NUM, SIGN, GUTTER: 3 + 2 * NUM + SIGN + 4 * 8, INDENT: 2 * NUM + 17 };
}
// Every window draws with the settings read or set last. A new font alone keeps the sizes, so the
// windows don't lay their rows out again.
let C = DEFAULT_CONFIG, M = metrics(C);
function apply(next) {
  if (next.codeFontSize !== C.codeFontSize || next.codeLineHeight !== C.codeLineHeight) M = metrics(next);
  C = next;
}
// Code fonts are most likely among the names that say so.
const MONO = /mono(?!type)|monaspace|\bcode|coding|consol|courier|menlo|monaco|fixed|term|iosevka|hack/i;
// The font list draws this many; typing finds the rest.
const FONT_ROWS = 120;
const sameConfig = (a, b) => Object.keys(DEFAULT_CONFIG).every((k) => a[k] === b[k]);

const stop = (_e, cx) => cx.stop_propagation();
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const sameText = (a, b) => a.length === b.length && a.every((row, i) => row.kind === b[i].kind && row.text === b[i].text);
// A comment box: its margins, border and padding, then a line for its place and one per text line.
const commentSize = (lines) => 8 + 2 + 16 + M.LINE * (lines + 1) + 4 * lines;

export default class Review extends View {
  init(_props, cx) {
    this.p = props() ?? {};
    this.files = []; this.byPath = new Map(); this.gone = []; this.order = [];
    // path → { rows, note, cut, widest, done, loading, stale, token, lang, painter, pieces, under, block, first, at }.
    this.diffs = new Map(); this.loads = 0;
    // What the scroll draws: { kind: "head" | "row" | "note" | "comment" | "gap", path, ... }.
    this.items = []; this.heads = new Map();
    this.sel = { path: null, picks: new Set(), pivot: null }; this.press = null; this.editing = null; this.open = null;
    this.notice = null; this.hint = null; this.armed = false; this.hasText = false; this.focused = null;
    this.draftKey = `${this.p.sessionId ?? this.p.terminal}:${this.p.root}:${this.p.parentCwd ? "worktree" : "local"}`;
    this.draft = drafts.get(this.draftKey) ?? { comments: [], note: "", seq: 0 };
    if (this.p.root) drafts.set(this.draftKey, this.draft);
    this.handle = cx.focus_handle();
    // A comment wraps to the pane's width, so a new width lays the items out again; the composer
    // opening under the view keeps the picked lines in it.
    this.scroll = new Scroller("review-diff", { horizontal: true, onResize: ({ width, shorter }) => { if (width) this.layout(); if (shorter) this.keepInView(); } });
    this.list = new Scroller("review-files");
    // An unsaved comment outlives the window with the drafts: its text, its lines, the comment it edits.
    const kept = this.draft.compose;
    this.composer = TextareaState.new({ placeholder: "Comment on the selected lines · ⌘↩ adds it", value: kept?.text ?? "", rows: 3 });
    if (kept) {
      this.sel = { path: kept.sel.path, picks: new Set(kept.sel.picks), pivot: kept.sel.pivot };
      this.editing = this.draft.comments.some((c) => c.id === kept.editing) ? kept.editing : null;
      this.hasText = Boolean(kept.text.trim());
      this.draft.compose = null;
    }
    this.composer.on("submit", (e, cx) => { if (e.secondary && !e.shift) this.save(cx); });
    this.composer.on("change", (_e, cx) => {
      const had = this.hasText, hinted = Boolean(this.hint);
      this.hasText = Boolean(this.composer.value().trim()); this.armed = false; this.hint = null;
      if (had !== this.hasText || hinted) cx.notify();
    });
    this.noteBox = TextareaState.new({ placeholder: "General note (optional) · ⌘↩ sends the review", value: this.draft.note, rows: 2 });
    this.noteBox.on("submit", (e, cx) => { if (e.secondary && !e.shift) this.send(cx); });
    this.noteBox.on("change", (_e, cx) => {
      const had = Boolean(this.draft.note.trim());
      this.draft.note = this.noteBox.value();
      if (had !== Boolean(this.draft.note.trim())) cx.notify();
    });
    // The settings' font list filters by this; Enter takes the first font the list shows.
    this.fontFilter = InputState.new({ placeholder: "Filter fonts · ↩ takes the first" });
    this.fontFilter.on("change", (_e, cx) => cx.notify());
    this.fontFilter.on("submit", (_e, cx) => { const [first] = this.fontOptions(); if (first !== undefined) this.setConfig({ codeFontFamily: first }, cx); });
    // The box that has the keyboard, if one does: keys then type into it.
    for (const box of [this.composer, this.noteBox, this.fontFilter]) {
      box.on("focus", () => { this.focused = box; });
      box.on("blur", () => { if (this.focused === box) this.focused = null; });
    }
    if (checking()) return;
    this.handle.focus();
    // The saved settings, when they aren't the ones the last window drew with: read after the writes
    // under way, and dropped if a setting changed meanwhile, which is newer.
    cx.spawn(async (cx) => {
      await saving;
      const seen = C, { config, path } = await modConfig.loadSafe();
      this.configPath = path;
      if (this.closed || C !== seen || sameConfig(config, C)) return;
      apply(config);
      cx.notify();
    });
    this.load(cx);
  }

  close() {
    this.closed = true;
    this.loadToken = null;
    const text = this.composer.value();
    this.draft.compose = text.trim() || this.editing
      ? { text, sel: { path: this.sel.path, picks: [...this.sel.picks], pivot: this.sel.pivot }, editing: this.editing }
      : null;
    this.composer.release(); this.noteBox.release(); this.fontFilter.release();
    if (!this.draft.comments.length && !this.draft.note.trim() && !this.draft.compose) drafts.delete(this.draftKey);
  }

  git(args, cwd = this.p.root) {
    return exec("git", [...READ, ...args], { cwd }).then((r) => {
      if (r.code !== 0) throw new Error(r.stderr.trim() || `git ${args[0]} exited ${r.code}`);
      return r.stdout;
    });
  }

  foregroundPid() {
    return hc(["get", this.p.terminal, "--json"]).then((r) => JSON.parse(r.stdout || "null")?.foreground?.pid ?? null).catch(() => null);
  }

  // Where Send goes. A Claude session is matched by its id; another agent by the process it ran when
  // the window opened. Anything else (a shell) would take the review as typed input: Copy only.
  canSend() { return Boolean(this.p.terminal && (this.p.sessionId || (this.p.app && this.pid))); }

  // The file list. Each file's diff loads once it comes near the view (loadNear).
  load(cx) {
    const token = this.loadToken = {};
    this.loading = true; this.error = null; cx.notify();
    const { root, parentCwd, sessionId, app, terminal } = this.p;
    const wantPid = !sessionId && app && terminal && this.pid === undefined;
    cx.spawn(async (cx) => {
      try {
        if (!root) throw new Error("No folder to review");
        const [head, branch, pid] = await Promise.all([
          parentCwd ? this.git(["rev-parse", "HEAD", "--abbrev-ref", "HEAD"], parentCwd) : this.git(["rev-parse", "--verify", "HEAD"]).catch(() => null),
          this.git(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "HEAD"),
          wantPid ? this.foregroundPid() : undefined,
        ]);
        if (this.loadToken !== token) return;
        if (wantPid) this.pid = pid;
        let base, parentBranch = null;
        if (parentCwd) {
          // The merge-base with the parent's HEAD: what the subagent changed, without what the parent committed since.
          const [parentHead, name] = head.trim().split("\n");
          base = (await this.git(["merge-base", "HEAD", parentHead])).trim();
          // A detached HEAD (jj, a rebase) has no branch name.
          parentBranch = name === "HEAD" ? parentHead.slice(0, 7) : name;
        } else {
          // An unborn branch has no HEAD yet: every file is new against the empty tree.
          base = (head ?? await this.git(["hash-object", "-t", "tree", "/dev/null"])).trim();
        }
        const [numstat, nameStatus, untracked] = await Promise.all([
          this.git(["diff", base, ...DIFF, "-z", "--no-renames", "--numstat"]),
          this.git(["diff", base, ...DIFF, "-z", "--no-renames", "--name-status"]),
          this.git(["ls-files", "--others", "--exclude-standard", "-z"]),
        ]);
        if (this.loadToken !== token) return;
        const files = parseFiles(numstat, nameStatus);
        for (const path of untracked.split("\0").filter(Boolean)) {
          // A new file's line count comes from reading it: keep the last one until it is read again.
          files.push({ path, status: "A", add: this.byPath.get(path)?.fresh ? this.byPath.get(path).add : 0, del: 0, binary: false, fresh: true });
        }
        files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        this.limited = files.length > MAX_FILES;
        this.files = files.slice(0, MAX_FILES);
        this.byPath = new Map(this.files.map((f) => [f.path, f]));
        this.base = base; this.parentBranch = parentBranch;
        this.branch = branch.trim() === "HEAD" ? null : branch.trim();
        // A diff from before stays drawn until its file loads again, so a reload doesn't blank the view.
        for (const [path, d] of this.diffs) {
          if (!this.byPath.has(path)) this.diffs.delete(path);
          else { d.stale = true; d.loading = false; d.token = null; }
        }
        this.listGone(); this.layout();
      } catch (e) {
        if (this.loadToken !== token) return;
        this.error = String(e.message ?? e); this.files = []; this.byPath = new Map(); this.gone = []; this.diffs.clear(); this.base = null; this.layout();
      } finally {
        if (this.loadToken === token) { this.loading = false; if (!this.closed) cx.notify(); }
      }
    });
  }

  // Files with unsent comments that left the diff: listed after the rest, so those comments stay reachable.
  listGone() {
    this.gone = [...new Set(this.draft.comments.filter((c) => !c.sent && !this.byPath.has(c.path)).map((c) => c.path))].sort();
  }

  // Loads (or reloads, after a refresh) the diffs of the files within NEAR screens of the view: the
  // ones in view first, then below and above it, nearest first.
  loadNear(cx) {
    const s = this.scroll, h = s.height || 900, from = s.top - h * NEAR, to = s.top + h * (1 + NEAR);
    if (this.loads >= LOADS || !this.order.length) return;
    const at = Math.max(0, this.order.indexOf(this.open)), last = s.top + h;
    const wants = (path) => {
      const head = this.heads.get(path), file = this.byPath.get(path), d = this.diffs.get(path);
      return file && !(d && (d.loading || !d.stale)) && s.offsets[head] <= to && s.offsets[this.items[head].end] >= from;
    };
    const ahead = [], behind = [];
    for (let k = at; k < this.order.length && s.offsets[this.heads.get(this.order[k])] <= to; k++) {
      (s.offsets[this.heads.get(this.order[k])] < last ? ahead : behind).push(this.order[k]);
    }
    for (let k = at - 1; k >= 0 && s.offsets[this.items[this.heads.get(this.order[k])].end] >= from; k--) behind.push(this.order[k]);
    // Below before above: reading goes down.
    behind.sort((a, b) => (s.offsets[this.heads.get(a)] < s.top) - (s.offsets[this.heads.get(b)] < s.top));
    for (const path of [...ahead, ...behind]) {
      if (this.loads >= LOADS) return;
      if (wants(path)) this.loadDiff(this.byPath.get(path), cx);
    }
  }

  loadDiff(file, cx) {
    const { path } = file;
    let d = this.diffs.get(path);
    if (!d) this.diffs.set(path, d = { rows: null, note: null, cut: 0, widest: 0, done: false, lang: languageOf(path), painter: null, pieces: new Map(), under: new Set(), block: null, first: 0, at: null });
    const token = d.token = {}, base = this.base;
    d.loading = true; d.stale = false; this.loads++;
    cx.spawn(async (cx) => {
      let diff = null, note = null;
      try {
        if (file.fresh) {
          const text = await readTextFile(`${this.p.root}/${path}`).catch(() => null);
          if (text === null) note = "Cannot preview this file (binary, too large, or unreadable)";
          else if (text.includes("\0")) note = "Binary file · no text diff";
          else { diff = addedRows(text, MAX_ROWS, MAX_LINE); file.add = Math.max(0, diff.total - 1); if (!diff.total) note = "Empty file"; }
        } else {
          diff = parseDiff(await this.git(["diff", base, ...DIFF, "--", path]), MAX_ROWS, MAX_LINE);
          if (!diff) note = file.status === "U" ? "Unmerged file · resolve the conflict to see its diff" : file.binary ? "Binary file changed" : "No text diff (mode change only)";
        }
      } catch (e) { note = `Cannot preview this diff: ${e.message ?? e}`; }
      finally { this.loads--; }
      if (this.closed || d.token !== token || this.diffs.get(path) !== d) return;
      const next = diff?.rows ?? null;
      // The same text keeps its colours, so a refresh that changed nothing doesn't flash.
      if (!next || !d.rows || !sameText(next, d.rows)) { d.painter = next && d.lang ? painter(next) : null; d.pieces = new Map(); }
      d.rows = next; d.note = note; d.cut = diff && diff.total > MAX_ROWS ? diff.total : 0; d.done = true; d.loading = false;
      d.widest = 0;
      for (const row of next ?? []) d.widest = Math.max(d.widest, cells(row.text));
      d.block = null;
      if (this.sel.path === path) {
        // Picked lines that are still code stay picked.
        this.sel.picks = new Set([...this.sel.picks].filter((i) => isLine(next?.[i])));
        if (!isLine(next?.[this.sel.pivot])) this.sel.pivot = null;
        this.press = null;
      }
      this.layout();
      cx.notify();
    });
  }

  // Syntax colour comes after the rows, PAINT_ROWS lines at a time so input and frames get through:
  // the rows on screen first, then the next screen down, then half a screen up. Each step parses on
  // from where the last one in that text stopped. A language's parser loads with its first step.
  paint(cx) {
    if (this.painting || this.closed || !this.nextChunk()) return;
    this.painting = true;
    cx.spawn(async (cx) => {
      let unseen = false;
      try {
        for (let job; !this.closed && (job = this.nextChunk());) {
          const { d, i } = job, p = d.painter;
          const start = await spanner(d.lang).catch(() => null);
          if (!start) { d.lang = null; continue; }
          if (d.painter !== p) continue;
          const batch = new Map();
          let from, to;
          try { [from, to] = p.step(i, PAINT_ROWS, start, batch); }
          catch {
            if (d.painter === p) { d.painter = null; d.pieces.clear(); unseen = true; }
            continue;
          }
          for (const [r, runs] of batch) d.pieces.set(r, pieces(d.rows[r].text, runs));
          // Redraw for rows on screen; the rest show when the view reaches them.
          if (this.onScreen(d, from, to + 1)) cx.notify(); else unseen = true;
          await cx.sleep(1);
        }
      } finally {
        this.painting = false;
        if (unseen && !this.closed) cx.notify();
      }
    });
  }

  nextChunk() {
    const s = this.scroll, h = s.height || 900, items = this.items;
    const top = Math.max(0, s.indexAt(0)), screen = s.indexAt(h), below = s.indexAt(h * 2), above = Math.max(0, s.indexAt(-h / 2));
    const end = (i) => (i < 0 ? items.length : i + 1);
    for (const [a, b] of [[top, end(screen)], [end(screen), end(below)], [above, top]]) {
      for (let i = a; i < b; i++) {
        const item = items[i];
        if (item.kind === "row" && item.d.lang && item.d.painter?.needs(item.i)) return { d: item.d, i: item.i };
      }
    }
    return null;
  }

  onScreen(d, from, to) {
    const s = this.scroll, a = d.at?.[from], b = d.at?.[to - 1];
    return a !== undefined && b !== undefined && s.offsets[d.first + b + 1] > s.top && s.offsets[d.first + a] < s.top + (s.height || 900);
  }

  // The items: per file its block. The item at the top of the view stays where it is on screen.
  layout() {
    const keep = this.anchorAt(), cols = this.commentCols();
    const items = [], sizes = [], heads = new Map(), mine = new Map();
    for (const c of this.draft.comments) {
      if (this.base && !this.byPath.has(c.path)) c.outdated = true;
      (mine.get(c.path) ?? mine.set(c.path, []).get(c.path)).push(c);
    }
    this.order = [...this.files.map((f) => f.path), ...this.gone];
    for (const path of this.order) {
      const block = this.block(path, mine.get(path) ?? [], cols), head = items.length, d = this.diffs.get(path);
      heads.set(path, head);
      if (d) d.first = head;
      for (let k = 0; k < block.items.length; k++) { items.push(block.items[k]); sizes.push(block.sizes[k]); }
      items[head].end = items.length;
    }
    this.items = items; this.heads = heads;
    // The last file's header can scroll to the top, past the end of its diff.
    this.scroll.measure(sizes, items.length ? heads.get(this.order.at(-1)) : -1);
    if (keep) this.scroll.setTop(this.offsetOf(keep));
    this.list.measure(this.order.map(() => FILE));
  }

  // One file's items: a header, its notes, its outdated comments, its rows with their comments
  // under them, and a gap. A loaded diff keeps them until its rows, its comments or (with comments)
  // the width change. A comment whose line moved takes the line's new number.
  block(path, comments, cols) {
    const d = this.diffs.get(path), live = this.byPath.has(path), loaded = live && Boolean(d?.done);
    const key = `${M.size}/${M.ROW}/${M.LINE}|${loaded}|${Boolean(this.base)}|${comments.length ? cols : ""}|${comments.map((c) => `${c.id}:${c.body}`).join("\0")}`;
    if (loaded && d.block?.key === key) return d.block;
    const items = [], sizes = [];
    const push = (item, size) => { items.push(item); sizes.push(size); };
    const note = (text) => push({ kind: "note", path, text }, M.NOTE);
    const comment = (c, outdated) => {
      const lines = wrap(c.body, cols);
      push({ kind: "comment", path, c, outdated, lines }, commentSize(lines.length));
    };
    push({ kind: "head", path }, M.HEAD);
    if (!live) {
      note("This file is no longer in the diff: its comments are outdated");
      for (const c of comments) comment(c, true);
    } else if (!loaded) note("Loading…");
    else {
      if (d.note) note(d.note);
      const rows = d.rows ?? [], under = new Map();
      for (const c of comments) {
        const i = anchorRow(rows, c);
        if (this.base) c.outdated = i < 0;
        if (i < 0) { comment(c, true); continue; }
        if (rows[i][c.side] !== c.end) Object.assign(c, moved(c, rows[i][c.side]));
        under.set(i, [...(under.get(i) ?? []), c]);
      }
      d.under = new Set(under.keys());
      d.at = new Int32Array(rows.length);
      for (let i = 0; i < rows.length; i++) {
        d.at[i] = items.length;
        push({ kind: "row", path, i, d }, M.ROW);
        for (const c of under.get(i) ?? []) comment(c, false);
      }
      if (d.cut) note(`Showing the first ${MAX_ROWS} of ${d.cut} diff lines`);
    }
    push({ kind: "gap", path }, GAP);
    const block = { key, items, sizes };
    if (loaded) d.block = block;
    return block;
  }

  // What the composer is about stays in view when the composer takes room from it: the comment
  // being edited, or the last line picked.
  keepInView() {
    const s = this.scroll;
    if (this.editing) {
      const head = this.heads.get(this.draft.comments.find((c) => c.id === this.editing)?.path);
      if (head === undefined) return;
      for (let i = head; i < this.items[head].end; i++) if (this.items[i].c?.id === this.editing) { s.reveal(i, M.ROW); return; }
    } else if (this.sel.picks.size && this.press === null) {
      const d = this.diffs.get(this.sel.path), at = d?.at?.[Math.max(...this.sel.picks)];
      if (at !== undefined) s.reveal(d.first + at, M.ROW);
    }
  }

  // The item at the top of the view and how far into it the view starts, to find it again after a layout.
  anchorAt() {
    const s = this.scroll, i = s.indexAt(0), item = this.items[i];
    if (!item) return null;
    const head = this.heads.get(item.path);
    return { item, delta: s.top - s.offsets[i], fromHead: s.top - s.offsets[head], toEnd: s.offsets[this.items[head].end] - s.top };
  }

  offsetOf({ item, delta, fromHead, toEnd }) {
    const o = this.scroll.offsets, head = this.heads.get(item.path);
    // Its file left the diff: the view stays at the same height.
    if (head === undefined) return this.scroll.top;
    if (item.kind === "head") return o[head] + delta;
    if (item.kind === "row") {
      const at = this.diffs.get(item.path)?.at?.[item.i];
      if (at !== undefined && this.items[head + at]?.kind === "row") return o[head + at] + delta;
    }
    if (item.kind === "comment") {
      for (let i = head; i < this.items[head].end; i++) if (this.items[i].c?.id === item.c.id) return o[i] + delta;
    }
    if (item.kind === "note") {
      for (let i = head; i < this.items[head].end; i++) if (this.items[i].kind === "note" && this.items[i].text === item.text) return o[i] + delta;
    }
    // The space after a file: as far before the file's end as it was.
    if (item.kind === "gap") return o[this.items[head].end] - toEnd;
    // A note that became rows, a row past the new end: the same distance into the file.
    return o[head] + fromHead;
  }

  commentCols() {
    const inner = Math.min(760, (this.scroll.width || 900) - M.INDENT - 12) - 22;
    return Math.max(20, Math.floor(inner / M.COL));
  }

  // The file whose part of the scroll holds the top of the view.
  openAt() {
    return this.items[Math.max(0, this.scroll.indexAt(0))]?.path ?? null;
  }

  // A file's header to the top of the view.
  jump(path, cx) {
    const head = this.heads.get(path);
    if (head === undefined) return;
    this.handle.focus();
    this.scroll.setTop(this.scroll.offsets[head]); this.scroll.left = 0;
    cx.notify();
  }

  // Keys move to the previous or next file's header, gone ones included.
  step(by, cx) {
    if (!this.order.length) return;
    const at = this.order.indexOf(this.open);
    this.jump(this.order[at < 0 ? 0 : Math.min(this.order.length - 1, Math.max(0, at + by))], cx);
  }

  clearPicks() { this.sel = { path: null, picks: new Set(), pivot: null }; this.press = null; }

  rowsOf(path) { return this.diffs.get(path)?.rows ?? []; }

  setText(text) {
    this.composer.set_value(text);
    this.hasText = Boolean(text.trim()); this.armed = false; this.hint = null;
  }

  // Text in the composer that isn't saved: a new comment's, or an edit that differs from the comment.
  dirty() {
    const text = this.composer.value().trim();
    const c = this.editing && this.draft.comments.find((c) => c.id === this.editing);
    return text !== (c ? c.body : "");
  }

  // Unsaved text is never discarded by a click elsewhere: the composer says what to do first.
  blocked(cx) {
    if (!this.dirty()) return false;
    this.hint = this.editing ? "Save or cancel this edit first" : "Add or cancel this comment first";
    cx.notify();
    return true;
  }

  // Press: pick one line (and start a drag); shift stretches from the last line picked;
  // cmd adds the line, or takes it out. A selection is in one file: a press in another starts
  // a new one there. A new comment's text stays for the new lines.
  pressRow(path, i, e, cx) {
    const rows = this.rowsOf(path);
    if (!isLine(rows[i])) return;
    if (this.editing) {
      if (this.blocked(cx)) return;
      this.editing = null; this.setText("");
    }
    const m = e.modifiers ?? {};
    this.notice = null; this.hint = null;
    if (this.sel.path !== path) this.sel = { path, picks: new Set(), pivot: null };
    const sel = this.sel;
    if (m.platform) {
      const picks = new Set(sel.picks);
      if (picks.has(i)) picks.delete(i); else picks.add(i);
      sel.picks = picks; sel.pivot = i; this.press = null;
    } else if (m.shift && sel.pivot !== null) {
      sel.picks = new Set(range(sel.pivot, i).filter((k) => isLine(rows[k]))); this.press = null;
    } else {
      sel.picks = new Set([i]); sel.pivot = i; this.press = i;
    }
    if (this.press === null) this.composer.focus();
    cx.notify();
  }

  // While a press is held, the lines from it to the pointer are picked.
  dragTo(path, i, cx) {
    if (this.press === null || path !== this.sel.path) return;
    const rows = this.rowsOf(path), picks = range(this.press, i).filter((k) => isLine(rows[k]));
    if (picks.length === this.sel.picks.size && picks.every((k) => this.sel.picks.has(k))) return;
    this.sel.picks = new Set(picks); cx.notify();
  }

  release(cx) {
    this.scroll.dragging = this.list.dragging = null;
    if (this.press === null) return;
    this.press = null;
    if (this.sel.picks.size) this.composer.focus();
    cx.notify();
  }

  edit(id, cx) {
    const c = this.draft.comments.find((c) => c.id === id);
    if (!c || id === this.editing || this.blocked(cx)) return;
    this.editing = id; this.clearPicks(); this.notice = null;
    this.setText(c.body); this.composer.focus();
    cx.notify();
  }

  remove(id, cx) {
    this.draft.comments = this.draft.comments.filter((c) => c.id !== id);
    if (this.editing === id) { this.editing = null; this.setText(""); this.handle.focus(); }
    this.listGone(); this.layout(); cx.notify();
  }

  cancel(cx) {
    this.clearPicks(); this.editing = null; this.setText(""); this.handle.focus();
    cx.notify();
  }

  // Esc drops the selection; with unsaved text it asks once more first.
  escape(cx) {
    if (this.settingsOpen) { this.toggleSettings(cx); return; }
    if (this.sel.picks.size || this.editing || this.hasText) {
      if (this.dirty() && !this.armed) { this.armed = true; this.hint = "Esc again discards this comment"; cx.notify(); return; }
      this.cancel(cx);
    } else closeOverlay(this.p.overlay);
  }

  save(cx) {
    const body = this.composer.value().trim();
    if (!body) return;
    if (this.editing) {
      const c = this.draft.comments.find((c) => c.id === this.editing);
      // An edited sent comment goes out again with the next send.
      if (c && c.body !== body) { c.body = body; c.sent = false; }
    } else {
      const { path, picks } = this.sel, at = anchor(this.rowsOf(path), [...picks]);
      if (!at || !this.byPath.has(path)) return;
      this.draft.comments.push({ id: ++this.draft.seq, path, ...at, body });
    }
    this.cancel(cx);
    this.layout();
  }

  unsent() { return this.draft.comments.filter((c) => !c.sent); }

  message(comments, note) {
    const { agent, root } = this.p;
    return feedback({ agent: this.p.parentCwd ? agent : null, root, branch: this.branch, base: this.base, parentBranch: this.parentBranch, comments, note });
  }

  copy(cx) {
    const comments = this.unsent(), note = this.draft.note;
    if (!this.base || (!comments.length && !note.trim())) return;
    const text = this.message(comments, note);
    this.notice = text ? { text: "Copied the review. Nothing was sent." } : { error: true, text: "This review is too long to copy. Delete or shorten some comments." };
    if (text) cx.write_to_clipboard(text);
    cx.notify();
  }

  // Throws unless `terminal` still runs the agent this review is for: a terminal now running something
  // else (a shell, another session) would get the feedback as input.
  async checkTarget() {
    const { terminal, sessionId, claudeDir, parentCwd } = this.p;
    const pid = await this.foregroundPid();
    if (sessionId) {
      const session = pid ? await readTextFile(`${claudeDir}/sessions/${pid}.json`).catch(() => null) : null;
      let owner = null;
      try { owner = JSON.parse(session ?? "null")?.sessionId ?? null; } catch {}
      if (owner !== sessionId) throw new Error(`${terminal} no longer runs the Claude session ${parentCwd ? "that started this subagent" : "this review is for"}. Nothing was sent.`);
    } else if (!pid || pid !== this.pid) throw new Error(`${terminal} no longer runs the agent this review is for. Nothing was sent.`);
  }

  // Sent comments stay, dimmed, so the next round can check them; a comment edited while the send ran
  // stays unsent.
  send(cx) {
    const { terminal, agent } = this.p;
    const comments = this.unsent(), note = this.draft.note;
    if (this.sending || !this.base || !this.canSend() || (!comments.length && !note.trim())) return;
    const text = this.message(comments, note);
    if (!text) { this.notice = { error: true, text: "This review is too long to send. Delete or shorten some comments." }; cx.notify(); return; }
    const bodies = new Map(comments.map((c) => [c.id, c.body]));
    const token = this.sendToken = {};
    this.sending = true; this.notice = null; cx.notify();
    // `hc send` waits while the terminal holds a person's unfinished draft.
    cx.timer.after(3000, (cx) => {
      if (this.sendToken !== token || !this.sending || this.closed) return;
      this.notice = { text: `Waiting for ${terminal}: it may hold an unfinished draft.` }; cx.notify();
    });
    cx.spawn(async (cx) => {
      try {
        await this.checkTarget();
        if (this.closed) return;
        const r = await hc(["send", terminal, text]);
        if (r.code !== 0) throw new Error(`Delivery not confirmed (${(r.stderr || r.stdout).trim() || `exit ${r.code}`}). Check ${terminal} before sending again.`);
        for (const c of this.draft.comments) if (bodies.get(c.id) === c.body) c.sent = true;
        if (this.draft.note === note) { this.draft.note = ""; if (!this.closed) this.noteBox.set_value(""); }
        this.notice = { text: this.p.parentCwd ? `Sent to ${terminal}. Claude relays it to ${agent.label}.` : `Sent to ${terminal}.` };
        if (!this.closed) { this.listGone(); this.layout(); }
      } catch (e) {
        this.notice = { error: true, text: String(e.message ?? e) };
      } finally {
        this.sending = false; this.sendToken = null;
        if (!this.closed) cx.notify();
      }
    });
  }

  clearSent(cx) {
    this.draft.comments = this.draft.comments.filter((c) => !c.sent);
    if (this.editing && !this.draft.comments.some((c) => c.id === this.editing)) { this.editing = null; this.setText(""); this.handle.focus(); }
    this.notice = null; this.listGone(); this.layout(); cx.notify();
  }

  // A setting takes effect here at once (render lays the items out again), then in config.json.
  setConfig(change, cx) {
    const next = { ...C, ...change };
    if (sameConfig(next, C)) return;
    apply(next);
    cx.notify();
    if (checking()) return;
    const write = saving.then(() => saveConfig(change));
    saving = write.catch(() => {});
    cx.spawn(async (cx) => {
      try {
        await write;
      } catch (e) {
        if (this.closed) return;
        this.notice = { text: `Settings not saved: ${e?.message ?? e}`, error: true };
        cx.notify();
      }
    });
  }

  toggleSettings(cx) {
    this.settingsOpen = !this.settingsOpen;
    if (!this.settingsOpen) { this.fontsOpen = false; this.leaveFilter(); }
    cx.notify();
  }

  // The machine's fonts, the mono-looking ones first, sorted once a window.
  toggleFonts(cx) {
    this.fontsOpen = !this.fontsOpen;
    if (this.fontsOpen) {
      this.fontNames ??= [...new Set(fonts())].map((name) => [MONO.test(name), name])
        .sort((a, b) => (b[0] - a[0]) || a[1].localeCompare(b[1])).map(([, name]) => name);
      this.fontFilter.set_value("");
      this.back = this.focused;
      if (!checking()) this.fontFilter.focus();
    } else this.leaveFilter();
    cx.notify();
  }

  // The keyboard goes back to where it was before the font filter took it.
  leaveFilter() {
    if (this.focused === this.fontFilter) (this.back ?? this.handle).focus();
  }

  // The fonts the list offers: null, the app's own, first while nothing is typed.
  fontOptions() {
    const q = this.fontFilter.value().trim().toLowerCase();
    const names = (this.fontNames ?? []).filter((name) => !q || name.toLowerCase().includes(q));
    return q ? names : [null, ...names];
  }

  // The gear's panel, over the window: a press outside it closes it. Its wheel stays in it.
  settingsView(t) {
    const { codeFontSize: size, codeLineHeight: lh, codeFontFamily: family } = C;
    const app = settings().font_family ?? "JetBrains Mono", path = this.configPath ?? "", own = home();
    const shown = path.startsWith(`${own}/`) ? `~${path.slice(own.length)}` : path;
    const stepper = (id, label, value, down, up) => h_flex().gap(6).items_center()
      .child(div().flex_1().text_color(t.muted).child(label))
      .child(this.icon(`${id}-down`, `${ICONS}/minus.svg`, "Less", Boolean(down), down, t))
      .child(div().w(32).text_center().child(value))
      .child(this.icon(`${id}-up`, `${ICONS}/plus.svg`, "More", Boolean(up), up, t));
    const set = (change) => (cx) => this.setConfig(change, cx);
    return div().absolute().inset_0().on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.toggleSettings(cx); })
      .child(v_flex().id("review-settings-panel").absolute().top(44).right(12).w(280).p(12).gap(10).rounded(8)
        .bg(t.popover).border_1().border_color(t.border).shadow_lg().text_size(12).on_mouse_down("left", stop).on_scroll_wheel(stop)
        .child(div().font_semibold().child("Review settings"))
        .child(stepper("review-font-size", "Code font size", String(size),
          size > FONT_MIN && set({ codeFontSize: size - 1 }), size < FONT_MAX && set({ codeFontSize: size + 1 })))
        .child(stepper("review-line-height", "Line height", lh.toFixed(1),
          lh > LINE_MIN && set({ codeLineHeight: tenth(lh - 0.1) }), lh < LINE_MAX && set({ codeLineHeight: tenth(lh + 0.1) })))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_none().text_color(t.muted).child("Code font"))
          .child(h_flex().id("review-font-family").flex_1().min_w(0).h(26).pl(8).pr(4).gap(4).items_center().rounded(6).border_1()
            .border_color(this.fontsOpen ? t.accent : t.border).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.toggleFonts(cx))
            .child(div().flex_1().min_w(0).truncate().font_family(family ?? app).child(family ?? `${app} (app)`))
            .child(svg(`${ICONS}/chevron-down.svg`).size(12).flex_none().text_color(t.muted))))
        .when(Boolean(this.fontsOpen), (e) => e.child(this.fontList(t, family, app)))
        .child(h_flex().gap(8).items_center().text_size(11).text_color(t.dim)
          .child(div().flex_1().min_w(0).truncate().child(shown))
          .when(!sameConfig(C, DEFAULT_CONFIG), (e) => e.child(div().id("review-settings-reset").flex_none().cursor_pointer().text_color(t.muted)
            .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.setConfig(DEFAULT_CONFIG, cx)).child("Reset")))));
  }

  // The fonts to pick from; the code behind the panel shows the pick at once.
  fontList(t, family, app) {
    const options = this.fontOptions(), more = options.length - FONT_ROWS;
    const option = (value, k) => div().id(`review-font-${k}`).flex_none().h(24).px(8).flex().items_center().rounded(4).cursor_pointer()
      .when(value === family, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.setConfig({ codeFontFamily: value }, cx))
      .child(div().truncate().child(value ?? `${app} (app)`));
    const hint = (text) => div().px(8).py(4).text_color(t.dim).child(text);
    return v_flex().gap(6)
      .child(Input.new(this.fontFilter).h(28).w_full().px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_color(t.foreground))
      .child(v_flex().id("review-font-list").max_h(220).overflow_y_scroll().p(4).rounded(6).border_1().border_color(t.border)
        .children(options.slice(0, FONT_ROWS).map(option))
        .when(options.length === 0, (e) => e.child(hint("No font matches")))
        .when(more > 0, (e) => e.child(hint(`${more} more · type to narrow`))));
  }

  button(id, label, enabled, action, t, solid = false) {
    return div().id(id).h(28).px(12).flex().flex_none().items_center().rounded(7).text_size(12)
      .when(solid, (e) => e.bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim))
      .when(!solid, (e) => e.border_1().border_color(t.border).text_color(enabled ? t.foreground : t.dim))
      .when(enabled, (e) => e.cursor_pointer().on_click((_e, cx) => action(cx)))
      .on_mouse_down("left", stop)
      .child(label);
  }

  icon(id, path, tip, enabled, action, t) {
    return div().id(id).size(24).flex().flex_none().items_center().justify_center().rounded(6).tooltip(tip).on_mouse_down("left", stop)
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => action(cx)))
      .child(svg(path).size(14).text_color(enabled ? t.muted : t.dim));
  }

  statusColor(status, t) {
    return status === "A" ? t.ansi2 : status === "M" ? t.blocked : status === "?" ? t.dim : t.ansi1;
  }

  item(i, t, syntax) {
    const item = this.items[i];
    if (item.kind === "head") return this.header(item.path, t);
    if (item.kind === "row") return this.diffRow(item, t, syntax);
    if (item.kind === "comment") return this.commentRow(item, t);
    if (item.kind === "note") return div().w_full().h(M.NOTE).flex_none().px(12).flex().items_center().text_color(t.dim).child(div().truncate().child(unligature(item.text)));
    return div().w_full().h(GAP).flex_none();
  }

  // A file's header; `pinned` is the copy held at the top while its diff scrolls under it.
  header(path, t, pinned = false) {
    const f = this.byPath.get(path) ?? { status: "?", add: 0, del: 0 }, slash = path.lastIndexOf("/");
    const notes = this.draft.comments.filter((c) => !c.sent && c.path === path).length;
    return h_flex().id(pinned ? "review-pin" : `head-${path}`).w_full().h(M.HEAD).flex_none().px(12).gap(8).items_center()
      .bg(t.raised).border_y_1().border_color(t.border)
      .when(pinned, (e) => e.cursor_pointer().on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.jump(path, cx); }))
      .child(div().w(10).flex_none().text_color(this.statusColor(f.status, t)).child(f.status))
      .child(h_flex().flex_1().min_w(0)
        .child(div().min_w(0).truncate().text_color(t.dim).child(unligature(path.slice(0, slash + 1))))
        .child(div().flex_none().font_semibold().text_color(f.status === "?" ? t.dim : t.foreground).child(unligature(path.slice(slash + 1)))))
      .when(notes > 0, (e) => e.child(div().px(5).rounded(4).bg(t.accent).text_size(10).text_color(t.solid_foreground ?? t.background).child(plural(notes, "comment"))))
      .when(f.add > 0, (e) => e.child(div().text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().text_color(t.ansi1).child(`−${f.del}`)));
  }

  // The open file's header over the top of the view once its own has scrolled off; the next file's
  // header pushes it up.
  pin(t) {
    const s = this.scroll, head = this.heads.get(this.open);
    if (head === undefined || s.offsets[head] >= s.top) return null;
    const y = Math.min(0, s.offsets[this.items[head].end] - GAP - M.HEAD - s.top);
    return div().absolute().left(0).right(0).top(y).child(this.header(this.open, t, true));
  }

  diffRow({ path, i, d }, t, syntax) {
    const row = d.rows[i];
    if (row.kind === "@") return div().w_full().h(M.ROW).flex_none().px(12).flex().items_center().bg(t.raised).text_color(t.dim).child(div().truncate().child(unligature(row.text)));
    const here = this.sel.path === path, picked = here && this.sel.picks.has(i), line = isLine(row);
    return h_flex().id(`row-${path}:${i}`).w_full().h(M.ROW).flex_none().gap(8).items_center()
      .when(row.kind === "+", (e) => e.bg(t.ansi2 + "18")).when(row.kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .when(picked, (e) => e.bg(t.selected))
      .when(line, (e) => e.cursor_pointer().on_mouse_down("left", (ev, cx) => this.pressRow(path, i, ev, cx)))
      .when(line && !picked, (e) => e.hover((s) => s.bg(t.hover)))
      // Only a held press listens for moves: an idle view has no move handlers.
      .when(line && here && this.press !== null, (e) => e.on_mouse_move((_ev, cx) => this.dragTo(path, i, cx)))
      .child(div().w(3).h_full().flex_none().when(picked || d.under.has(i), (e) => e.bg(t.accent)))
      .child(div().w(M.NUM).flex_none().text_right().text_color(t.dim).child(row.old === undefined ? "" : String(row.old)))
      .child(div().w(M.NUM).flex_none().text_right().text_color(t.dim).child(row.new === undefined ? "" : String(row.new)))
      .child(div().w(M.SIGN).flex_none().text_color(row.kind === "+" ? t.ansi2 : row.kind === "-" ? t.ansi1 : t.dim).child(row.kind === "-" ? "−" : row.kind.trim()))
      .child(this.code(row, d, i, t, syntax));
  }

  // The code, moved by the sideways scroll; the numbers stay.
  code(row, d, i, t, syntax) {
    const plain = row.kind ? t.foreground : t.dim;
    let parts = d.pieces.get(i);
    if (!parts) d.pieces.set(i, parts = pieces(row.text));
    return div().flex_1().min_w(0).h_full().relative().overflow_hidden()
      .child(h_flex().absolute().top_0().bottom_0().left(-Math.round(this.scroll.left)).items_center().whitespace_nowrap()
        .children(parts.map(([text, key]) => div().flex_none().text_color(key ? syntax[key] ?? plain : plain).child(text))));
  }

  commentRow({ c, outdated, lines }, t) {
    const on = this.editing === c.id, sent = Boolean(c.sent);
    return div().w_full().h(commentSize(lines.length)).flex_none().pl(M.INDENT).pr(12).py(4).overflow_hidden()
      .child(v_flex().id(`comment-${c.id}`).max_w(760).px(10).py(8).gap(4).rounded(7).bg(t.raised).border_1().border_color(on ? t.accent : t.border)
        .cursor_pointer().hover((s) => s.border_color(t.accent)).on_click((_e, cx) => this.edit(c.id, cx))
        .child(h_flex().h(M.LINE).gap(6).items_center().text_color(t.dim)
          .child(div().flex_1().min_w(0).truncate().child(unligature(`${place(c)}${outdated ? " · outdated: the line changed" : ""}`)))
          .child(div().text_color(t.muted).child(on ? "editing" : sent ? "sent" : "click to edit")))
        .children(lines.map((line) => div().h(M.LINE).whitespace_nowrap().overflow_hidden().text_color(sent && !on ? t.dim : t.foreground).child(unligature(line) || " "))));
  }

  // The picked lines, or the comment being edited, and a box to write about them.
  composerView(t) {
    const editing = this.editing && this.draft.comments.find((c) => c.id === this.editing);
    if (this.press !== null && !editing) return null;
    const { path, picks } = this.sel;
    const at = !editing && picks.size ? anchor(this.rowsOf(path), [...picks]) : null;
    // Text kept from another file waits for lines to be picked.
    if (!editing && !at && !this.hasText) return null;
    const where = editing ? `Editing ${place(editing)}`
      : at ? `${place({ path, ...at })}${picks.size === 1 ? " · drag, shift-click or ⌘-click for more lines" : ""}`
      : "Pick the lines this comment is about";
    return v_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border).bg(t.background)
      .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(where))
        .when(Boolean(this.hint), (e) => e.child(div().flex_none().text_color(t.ansi3).child(this.hint))))
      .child(div().id("review-composer").w_full().on_mouse_down("left", stop).child(Textarea.new(this.composer).w_full().h(70).text_size(12)))
      .child(h_flex().gap(8).items_center()
        .when(Boolean(editing), (e) => e.child(this.button("review-delete", "Delete", true, (cx) => this.remove(editing.id, cx), t)))
        .child(div().flex_1())
        .child(this.button("review-cancel", "Cancel", true, (cx) => this.cancel(cx), t))
        .child(this.button("review-save", editing ? "Save" : "Add comment", this.hasText && Boolean(editing || at), (cx) => this.save(cx), t, true)));
  }

  fileRow(path, notes, t) {
    const f = this.byPath.get(path) ?? { status: "?", add: 0, del: 0 }, parts = path.split("/"), name = parts.pop();
    return h_flex().id(`review-file-${path}`).h(FILE).flex_none().mx(6).px(8).gap(6).items_center().rounded(7).cursor_pointer()
      .when(this.open === path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.jump(path, cx))
      .child(div().w(12).text_size(11).text_color(this.statusColor(f.status, t)).child(f.status))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? `${parts.join("/")}/` : "")).child(div().max_w(180).min_w(0).truncate().when(f.status === "?", (e) => e.text_color(t.dim)).child(name)))
      .when(notes > 0, (e) => e.child(div().px(5).rounded(4).bg(t.accent).text_size(10).text_color(t.solid_foreground ?? t.background).child(String(notes))))
      .when(f.add > 0, (e) => e.child(div().text_size(10).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().text_size(10).text_color(t.ansi1).child(`−${f.del}`)));
  }

  // Loading, empty and error states, in the middle of the diff pane.
  placeholder(t) {
    if (this.error) {
      return v_flex().absolute().inset_0().items_center().justify_center().gap(8).p(24).text_size(12)
        .child(div().text_color(t.foreground).child("Could not read the changes. The folder may have been removed."))
        .child(div().max_w(560).text_color(t.dim).child(this.error))
        .child(this.button("review-retry", "Retry", !this.loading, (cx) => this.load(cx), t));
    }
    if (this.order.length) return null;
    const text = this.loading ? "Loading changes…" : this.p.parentCwd ? `No changes vs ${this.parentBranch ?? "the parent"}` : "No uncommitted changes";
    return v_flex().absolute().inset_0().items_center().justify_center().text_size(12).text_color(t.dim).child(text);
  }

  render(cx) {
    const t = theme(), p = this.p, unsent = this.unsent(), count = unsent.length, sentCount = this.draft.comments.length - count;
    // Other code settings: every item's height with them.
    if (this.metrics !== M) { this.metrics = M; this.layout(); }
    // The list follows the file at the top of the view.
    const open = this.openAt();
    if (open !== this.open) { this.open = open; this.list.reveal(this.order.indexOf(open)); }
    if (!checking()) { this.loadNear(cx); this.paint(cx); }
    // The sideways scroll spans the widest line of the files in view.
    const [first, last] = this.scroll.visible();
    let widest = 0;
    for (let i = first; i < last; i++) { const item = this.items[i]; if (item.kind === "row" && item.d.widest > widest) widest = item.d.widest; }
    this.scroll.setContent(widest ? M.GUTTER + (widest + 2) * M.COL : 0);
    const hasReview = Boolean(this.base && (count || this.draft.note.trim()));
    const ready = hasReview && !this.sending && this.canSend();
    const mono = C.codeFontFamily ?? settings().font_family ?? "JetBrains Mono", composer = this.composerView(t), placeholder = this.placeholder(t);
    // The colours the files mod gives code.
    const syntax = { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 };
    const byFile = new Map();
    for (const c of unsent) byFile.set(c.path, (byFile.get(c.path) ?? 0) + 1);
    const name = p.parentCwd ? p.agent?.label ?? "" : (p.root ?? "").split("/").pop();
    const against = p.parentCwd ? `vs ${this.parentBranch} · ${this.base?.slice(0, 7)}` : `uncommitted · since ${this.base?.slice(0, 7)}`;
    const title = h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child("Review"))
      .child(div().max_w(260).truncate().text_color(t.foreground).child(name))
      .when(Boolean(this.branch), (e) => e.child(div().max_w(260).truncate().text_size(11).text_color(t.muted).child(this.branch)))
      .when(Boolean(this.base), (e) => e.child(div().text_size(11).text_color(t.dim).child(against)))
      .child(div().flex_1())
      .child(this.icon("review-reload", "mods/hj-review/refresh.svg", this.loading ? "Loading…" : "Reload", !this.loading, (cx) => this.load(cx), t))
      .child(this.icon("review-settings", `${ICONS}/settings.svg`, "Settings", true, (cx) => this.toggleSettings(cx), t)
        .when(Boolean(this.settingsOpen), (e) => e.bg(t.selected)))
      .child(this.icon("review-close", `${ICONS}/x.svg`, "Close", true, () => closeOverlay(p.overlay), t));

    const list = v_flex().w(260).flex_none().h_full().py(6).border_r(1).border_color(t.border)
      .child(this.list.view(t, (k) => this.fileRow(this.order[k], byFile.get(this.order[k]) ?? 0, t)));

    const diff = v_flex().flex_1().min_w(0).h_full()
      .child(v_flex().flex_1().min_h(0).relative().font_family(mono).text_size(M.size)
        .child(this.scroll.view(t, (i) => this.item(i, t, syntax), this.pin(t)))
        .when(Boolean(placeholder), (e) => e.child(placeholder)))
      .when(Boolean(composer), (e) => e.child(composer))
      .when(!composer && this.files.length > 0 && this.press === null, (e) => e.child(div().flex_none().px(12).py(6).border_t(1).border_color(t.border).text_size(11).text_color(t.dim).child(HINT)));

    const status = this.notice?.text ?? (!p.terminal ? `${plural(count, "comment")} · no terminal to send to: Copy instead`
      : !this.canSend() ? `${plural(count, "comment")} · ${p.terminal} runs no agent to send to: Copy instead`
      : p.parentCwd ? `${plural(count, "comment")} · to ${p.terminal}, relayed to ${p.agent?.label ?? "the subagent"}`
      : `${plural(count, "comment")} · to the agent in ${p.terminal}`);
    const footer = h_flex().flex_none().p(10).gap(10).items_end().border_t(1).border_color(t.border)
      .child(div().id("review-note").flex_1().min_w(0).on_mouse_down("left", stop).child(Textarea.new(this.noteBox).w_full().h(50).text_size(12)))
      .child(v_flex().w(300).flex_none().gap(6).items_end()
        .child(div().max_w(300).text_size(11).text_color(this.notice?.error ? t.ansi1 : t.dim).child(status))
        .child(h_flex().gap(8).items_center()
          .when(sentCount > 0, (e) => e.child(this.button("review-clear-sent", `Clear ${sentCount} sent`, true, (cx) => this.clearSent(cx), t)))
          .child(this.button("review-copy", "Copy", hasReview, (cx) => this.copy(cx), t))
          .child(this.button("review-send", this.sending ? "Sending…" : "Send review", ready, (cx) => this.send(cx), t, true))));

    // A release anywhere in the window ends a drag, and so does the pointer leaving it (a release out
    // there never arrives). The press itself is stopped below the title bar so it picks lines instead
    // of moving the window.
    return v_flex().id("hj-review").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_mouse_up("left", (_e, cx) => this.release(cx))
      .on_hover((hovered, cx) => { if (!hovered) this.release(cx); })
      .on_key_down((e, cx) => {
        if (e.key === "escape") { this.escape(cx); cx.stop_propagation(); return; }
        if (this.focused) return;
        if (e.key === "up" || e.key === "down") this.step(e.key === "up" ? -1 : 1, cx);
        else if (e.key === "pageup" || e.key === "pagedown") {
          const by = Math.max(M.ROW, this.scroll.height - 2 * M.ROW);
          if (this.scroll.setTop(this.scroll.top + (e.key === "pageup" ? -by : by))) cx.notify();
        } else return;
        cx.stop_propagation();
      })
      .child(title)
      .child(h_flex().flex_1().min_h(0).on_mouse_down("left", stop).child(list).child(diff))
      .when(this.limited, (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child(`Showing the first ${MAX_FILES} changed files`)))
      .child(div().on_mouse_down("left", stop).child(footer))
      .when(Boolean(this.settingsOpen), (e) => e.child(this.settingsView(t)));
  }
}
