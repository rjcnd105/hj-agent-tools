// One Open With menu for both the Files and Changes panels.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, VirtualListScrollHandle, Scrollbar } from "gpui-base";
import { props, theme, settings, home, checking, readTextFile, writeTextFile, exec, notify, openOverlay, closeOverlay } from "herdr";
// Copied from herdr/lib/mod-config.js by `just herdr-mods`.
import { createModConfig } from "./mod-config.js";

const MOD = "hj-menu";
const DEFAULT_EDITORS = [
  { label: "Zed", bundle: "dev.zed.Zed-Preview" },
  { label: "Cursor", bundle: "com.todesktop.230313mzl4w4u92" },
];
const modConfig = createModConfig({
  mod: MOD,
  envVars: ["HERDR_MOD_HJ_MENU_DIR"],
  file: "editors.json",
  defaults: { editors: DEFAULT_EDITORS },
  validate(parsed) {
    const editors = parsed?.editors;
    if (!Array.isArray(editors) || !editors.every(item =>
      typeof item?.label === "string" && item.label.trim() &&
      typeof item.bundle === "string" && /^[a-zA-Z0-9.-]+$/.test(item.bundle))) {
      throw new Error('Expected an "editors" array of { "label", "bundle" } entries.');
    }
    return { editors };
  },
  home, exec, readTextFile, checking,
});
const GROUP = { label: "Open With" };
const CONFIG = { label: "Config" };
const ICONS = "mods/workspace-chrome";
const ROW = 31, PAD = 5, INSET = 8, SEPARATOR = 9;
const MENU_WIDTH = 160, MENU_HEIGHT = 44, SUB_WIDTH = 140, SUB_MAX_ROWS = 12;
// Keep the two overlays' lifetimes together without persisting menu state.
const roots = new Map();
let escapeBound = false;

async function loadEditors() {
  return (await modConfig.load()).config.editors;
}

async function ensureConfig() {
  const dir = await modConfig.resolveDir();
  const path = `${dir}/editors.json`;
  // Leave existing files alone, including ones that could not be read.
  if (await readTextFile(path).catch(() => undefined) !== null) return path;
  const made = await exec("/bin/mkdir", ["-p", dir]);
  if (made.code !== 0) throw new Error(made.stderr.trim() || `mkdir exited ${made.code}`);
  try {
    await writeTextFile(path, JSON.stringify({ editors: DEFAULT_EDITORS }, null, 2) + "\n", null);
  } catch (err) {
    // Another instance may have created it while we were preparing the directory.
    if (await readTextFile(path) === null) throw err;
  }
  return path;
}

export default class FileMenu extends View {
  init(_props, cx) {
    this.data = props() ?? {};
    this.at = 0;
    this.group = null;
    this.origin = this.data.origin ?? window.mouse_position();
    this.items = typeof this.data.path === "string" && this.data.path.startsWith("/")
      ? this.data.parent ? roots.get(this.data.parent)?.submenu ?? [CONFIG] : [GROUP] : [];
    if (this.data.listHeight) this.scroll = VirtualListScrollHandle.new();
    this.handle = cx.focus_handle();
    this.handle.focus();
    if (!this.data.parent && this.data.overlay) roots.set(this.data.overlay, this);
    if (!escapeBound) {
      cx.bind_keys([{ keystroke: "escape", action: "hj_file_menu_dismiss", context: "HjFileOpenWith" }]);
      escapeBound = true;
    }
  }

  closeGroup(refocus = false) {
    if (!this.group) return;
    const id = this.group;
    this.group = null;
    closeOverlay(id);
    if (refocus) this.handle.focus();
  }

  close() {
    this.scroll?.release();
    if (this.data.parent) {
      const root = roots.get(this.data.parent);
      if (root && root.group === this.data.overlay) root.group = null;
    } else {
      roots.delete(this.data.overlay);
      this.closeGroup();
    }
  }

  dismiss() {
    const root = this.data.parent ? roots.get(this.data.parent) : this;
    root?.closeGroup();
    const id = root?.data.overlay ?? this.data.overlay;
    if (id) closeOverlay(id);
  }

  showGroup(bounds, cx) {
    if (this.group || this.opening) return;
    this.opening = true;
    cx.spawn(async () => {
      try {
        let error;
        // Read once per parent menu, not on each mouse move or render.
        if (!this.submenu) {
          let editors;
          try { editors = await loadEditors(); }
          catch (err) { editors = DEFAULT_EDITORS; error = err; }
          this.submenu = [...editors, CONFIG];
        }
        if (roots.get(this.data.overlay) !== this) return;
        if (error) notify({ title: "Could not read Open With config", body: `Using defaults. ${error.message ?? error}`, level: "error" });

        const zoom = Number(settings().zoom) || 1;
        const edge = (PAD + 1) * zoom;
        const { width, height } = window.viewport_size();
        // Hover supplies the row bounds; from the keyboard, use the clamped click position.
        if (!bounds) {
          const left = Math.max(0, Math.min(this.origin.x, width - MENU_WIDTH * zoom));
          const top = Math.max(0, Math.min(this.origin.y, height - MENU_HEIGHT * zoom));
          bounds = { x: left + edge, y: top + edge, width: MENU_WIDTH * zoom - 2 * edge };
        }
        const right = bounds.x + bounds.width + edge;
        const left = bounds.x - edge - SUB_WIDTH * zoom;
        const hasEditors = this.submenu.length > 1;
        const chrome = 2 * (PAD + 1) + (hasEditors ? SEPARATOR : 0);
        const wantedHeight = this.submenu.length * ROW + chrome;
        const popupHeight = Math.min(wantedHeight, SUB_MAX_ROWS * ROW + chrome, Math.max(2, Math.floor(height / zoom)));
        const listHeight = hasEditors && popupHeight < wantedHeight ? Math.max(1, popupHeight - chrome - ROW) : null;
        this.group = openOverlay({
          mod: MOD, kind: "popup", width: SUB_WIDTH, height: popupHeight,
          at: { x: right + SUB_WIDTH * zoom <= width ? right : Math.max(0, left), y: Math.max(0, bounds.y - edge) },
          props: { parent: this.data.overlay, path: this.data.path, listHeight },
        });
      } finally {
        this.opening = false;
      }
    });
  }

  choose(item, cx, bounds) {
    if (item === GROUP) return this.showGroup(bounds, cx);
    if (this.launching) return;
    this.launching = true;
    cx.spawn(async () => {
      try {
        const configPath = item === CONFIG ? await ensureConfig() : null;
        const argv = item === CONFIG ? ["-t", configPath] : ["-b", item.bundle, this.data.path];
        const out = await exec("/usr/bin/open", argv);
        if (out.code !== 0) throw new Error(out.stderr.trim() || `exit ${out.code}`);
        this.dismiss();
      } catch (err) {
        this.launching = false;
        notify({
          title: item === CONFIG ? "Could not open editor config" : `Could not open in ${item.label}`,
          body: String(err.message ?? err), level: "error",
        });
      }
    });
  }

  key(e, cx) {
    const item = this.items[this.at];
    if (e.key === "left" && this.data.parent) {
      const root = roots.get(this.data.parent);
      if (root) root.closeGroup(true);
      else closeOverlay(this.data.overlay);
    } else if (e.key === "right" && item === GROUP) this.showGroup(undefined, cx);
    else if (e.key === "enter" && item) this.choose(item, cx);
    else if ((e.key === "up" || e.key === "down") && this.items.length > 1) {
      this.at = (this.at + this.items.length + (e.key === "up" ? -1 : 1)) % this.items.length;
      if (this.at < this.items.length - 1) this.scroll?.scroll_to_item(this.at);
      cx.notify();
    } else return;
    cx.stop_propagation();
  }

  render() {
    const t = theme();
    const row = (item, i) => h_flex().id(`row-${i}`).h(ROW).flex_none().px(INSET).gap(9).rounded(7).items_center()
      .when(i === this.at, el => el.bg(t.selected))
      .when(item === GROUP, el => el.child(svg(`${ICONS}/folder.svg`).size(14).flex_none().text_color(t.muted)))
      .child(div().flex_1().min_w(0).truncate().child(item.label))
      .when(item === GROUP, el => el.child(svg(`${ICONS}/chevron-right.svg`).size(12).flex_none().text_color(t.muted)));
    const actionRow = (item, i) => row(item, i)
      .on_mouse_move((e, cx) => {
        if (item === GROUP) this.showGroup(e.bounds, cx);
        else if (this.at !== i) { this.at = i; cx.notify(); }
      })
      .on_click((e, cx) => this.choose(item, cx, e.bounds));
    const menu = v_flex().id("hj-file-menu").key_context("HjFileOpenWith").track_focus(this.handle)
      .w_full().min_h(0).p(PAD).bg(t.popover).text_size(12.8).text_color(t.foreground)
      .on_action("hj_file_menu_dismiss", () => this.dismiss())
      .on_key_down((e, cx) => this.key(e, cx));
    if (this.items.at(-1) !== CONFIG) return menu.children(this.items.map(actionRow));

    const count = this.items.length - 1;
    if (!this.scroll) menu.children(this.items.slice(0, count).map(actionRow));
    else {
      // Popups need an explicit viewport height. Keep Config under it, with uniform editor rows.
      const id = "open-with-editors";
      menu.child(v_flex().relative().w_full().h(this.data.listHeight)
        .child(v_virtual_list(id, count, ROW, i => String(i),
          ({ start, end }) => this.items.slice(start, end).map((item, i) => row(item, start + i).hover(s => s.bg(t.hover))))
          .size_full().track_scroll(this.scroll)
          .on_item_click((key, cx) => {
            const item = this.items[Number(key)];
            if (item) this.choose(item, cx);
          }))
        .child(Scrollbar.vertical(id).absolute().inset_0()));
    }
    return menu.when(count > 0, el => el.child(div().w_full().px(INSET).py((SEPARATOR - 1) / 2).flex_none()
      .child(div().w_full().h(1).flex_none().bg(t.border))))
      .child(actionRow(CONFIG, count));
  }
}
