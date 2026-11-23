// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, exec, home, checking, readTextFile, watchFolder, theme, settings, window, openOverlay } from "herdr";
// Copied from herdr/lib/mod-config.js by `just herdr-mods`.
import { createModConfig, posInt } from "./mod-config.js";

const DEFAULT_CONFIG = {
  pollMs: 10000,
  perFolderLimit: 500,
  totalLimit: 5000,
  menuMod: "hj-menu",
};
const modConfig = createModConfig({
  mod: "hj-files",
  envVars: ["HERDR_MOD_HJ_FILES_DIR"],
  defaults: DEFAULT_CONFIG,
  validate(parsed) {
    return {
      pollMs: posInt(parsed?.pollMs, DEFAULT_CONFIG.pollMs, 1000),
      perFolderLimit: posInt(parsed?.perFolderLimit, DEFAULT_CONFIG.perFolderLimit, 1),
      totalLimit: posInt(parsed?.totalLimit, DEFAULT_CONFIG.totalLimit, 1),
      menuMod: typeof parsed?.menuMod === "string" && parsed.menuMod.trim() ? parsed.menuMod.trim() : DEFAULT_CONFIG.menuMod,
    };
  },
  home, exec, readTextFile, checking,
});
let filesConfig = { ...DEFAULT_CONFIG };
const mountConfig = (view, cx) => modConfig.mount(view, cx, {
  watchFolder,
  onConfig({ config }) { filesConfig = config; },
  onChange(_result, cx) { cx.notify(); },
});

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };

async function directory(path, on, cap) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First ${cap + 1} | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '${path.replace(/['‘’‚‛]/g, "$&$&")}'`], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; limit="$2"; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt "$limit" ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path, String(cap)], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    if (checking()) return;
    mountConfig(this, cx);
    this.refresh(cx);
    const schedule = (cx) => {
      this.pollTimer = cx.timer.after(filesConfig.pollMs, (cx) => {
        if (window()?.active !== false && !this.loading) this.refresh(cx);
        schedule(cx);
      });
    };
    schedule(cx);
  }

  close() {
    this.pollTimer?.cancel?.();
    this.unwatch();
    modConfig.unmount(this);
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.unwatch();
    const token = this.watchToken = {};
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try {
        while (this.watchToken === token && this.current(context)) {
          this.watching = watchFolder(root);
          await this.watching;
          if (this.watchToken === token && this.current(context)) this.refresh(cx);
        }
      } catch { if (this.watchToken === token) this.watched = this.watchToken = null; }
    });
  }

  unwatch() {
    this.watched = this.watchToken = null;
    this.watching?.cancel();
    this.watching = null;
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const perFolder = filesConfig.perFolderLimit, total = filesConfig.totalLimit;
    const entries = await directory(path ? `${root}/${path}` : root, on, perFolder);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(perFolder, total - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > perFolder || used + entries.length > total) this.limited = true;
  }

  refresh(cx) {
    if (checking()) return;
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.unwatch(); this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, filesConfig.totalLimit)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        context.top = top?.code === 0 ? top.stdout.trim() : null;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  rows(prefix, depth, out, t) {
    const total = filesConfig.totalLimit;
    if (out.length >= total || depth > 40) return out;
    const context = this.context;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= total) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .on_mouse_down("right", (e, cx) => {
          if (!context?.cwd || context.on || !this.current(context) || window()?.platform !== "macos") return;
          cx.stop_propagation();
          const at = e.position;
          openOverlay({ mod: filesConfig.menuMod, kind: "popup", width: 160, height: 44, at, props: { path: `${context.cwd}/${path}`, origin: at } });
        })
        .child(entry.dir ? svg(`mods/hj-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/hj-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  // Opens the project (its git top level, else the folder shown) in hj-menu's Open With.
  projectMenu(e, cx) {
    const context = this.context, path = context?.top ?? context?.cwd;
    if (!path || context.on || !this.current(context) || window()?.platform !== "macos") return;
    cx.stop_propagation();
    const zoom = Number(settings().zoom) || 1, b = e.bounds;
    // Below the button with right edges aligned; at the pointer before the button is painted.
    const at = b ? { x: Math.max(0, b.x + b.width - 160 * zoom), y: b.y + b.height + 4 * zoom } : e.position;
    openOverlay({ mod: filesConfig.menuMod, kind: "popup", width: 160, height: 44, at, props: { path, origin: at } });
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    return v_flex().id("files").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
        // Open With runs /usr/bin/open on this Mac, so remote folders get no button.
        .when(Boolean(this.root) && !this.on && window()?.platform === "macos", el => el.child(div().id("files-more").size(22).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().hover(s => s.bg(t.hover))
          .on_mouse_down("left", (e, cx) => this.projectMenu(e, cx))
          .child(svg("mods/hj-files/ellipsis-vertical.svg").size(14).text_color(t.muted)))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child(`File list limited to ${filesConfig.perFolderLimit.toLocaleString()} entries per folder and ${filesConfig.totalLimit.toLocaleString()} total`)))))
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
