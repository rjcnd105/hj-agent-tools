// One file context menu for both the Files and Changes panels.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, theme, settings, exec, notify, openOverlay, closeOverlay } from "herdr";

const EDITORS = [
  { label: "Zed", bundle: "dev.zed.Zed-Preview" },
  { label: "Cursor", bundle: "com.todesktop.230313mzl4w4u92" },
];
const GROUP = { label: "Open With" };
const ICONS = "mods/workspace-chrome";
const ROW = 31, PAD = 5, MENU_WIDTH = 160, MENU_HEIGHT = 44, SUB_WIDTH = 140;
// Keep the two overlays' lifetimes together without persisting menu state.
const roots = new Map();
let escapeBound = false;

export default class FileMenu extends View {
  init(_props, cx) {
    this.data = props() ?? {};
    this.at = 0;
    this.group = null;
    this.origin = this.data.origin ?? window.mouse_position();
    this.items = typeof this.data.path === "string" && this.data.path.startsWith("/")
      ? this.data.parent ? EDITORS : [GROUP] : [];
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

  showGroup(bounds) {
    if (this.group) return;
    const zoom = Number(settings().zoom) || 1;
    const edge = (PAD + 1) * zoom;
    const { width, height } = window.viewport_size();
    // Pointer hover has the painted bounds. With the keyboard, anchor at the
    // original pointer, clamped just as the file context popup is.
    if (!bounds) {
      const left = Math.max(0, Math.min(this.origin.x, width - MENU_WIDTH * zoom));
      const top = Math.max(0, Math.min(this.origin.y, height - MENU_HEIGHT * zoom));
      bounds = { x: left + edge, y: top + edge, width: MENU_WIDTH * zoom - 2 * edge };
    }
    const right = bounds.x + bounds.width + edge;
    const left = bounds.x - edge - SUB_WIDTH * zoom;
    this.group = openOverlay({
      mod: "hj-menu", kind: "popup", width: SUB_WIDTH, height: EDITORS.length * ROW + 2 * (PAD + 1),
      at: { x: right + SUB_WIDTH * zoom <= width ? right : Math.max(0, left), y: Math.max(0, bounds.y - edge) },
      props: { parent: this.data.overlay, path: this.data.path },
    });
  }

  choose(item, cx, bounds) {
    if (item === GROUP) return this.showGroup(bounds);
    if (this.launching) return;
    this.launching = true;
    cx.spawn(async () => {
      try {
        const out = await exec("/usr/bin/open", ["-b", item.bundle, this.data.path]);
        if (out.code !== 0) throw new Error(out.stderr.trim() || `exit ${out.code}`);
        this.dismiss();
      } catch (err) {
        this.launching = false;
        notify({ title: `Could not open in ${item.label}`, body: String(err.message ?? err), level: "error" });
      }
    });
  }

  key(e, cx) {
    const item = this.items[this.at];
    if (e.key === "left" && this.data.parent) {
      const root = roots.get(this.data.parent);
      if (root) root.closeGroup(true);
      else closeOverlay(this.data.overlay);
    } else if (e.key === "right" && item === GROUP) this.showGroup();
    else if (e.key === "enter" && item) this.choose(item, cx);
    else if ((e.key === "up" || e.key === "down") && this.items.length > 1) {
      this.at = (this.at + this.items.length + (e.key === "up" ? -1 : 1)) % this.items.length;
      cx.notify();
    } else return;
    cx.stop_propagation();
  }

  render() {
    const t = theme();
    return v_flex().id("hj-file-menu").key_context("HjFileOpenWith").track_focus(this.handle)
      .w_full().min_h(0).p(PAD).bg(t.popover).text_size(12.8).text_color(t.foreground)
      .on_action("hj_file_menu_dismiss", () => this.dismiss())
      .on_key_down((e, cx) => this.key(e, cx))
      .children(this.items.map((item, i) => h_flex().id(`row-${i}`).h(ROW).px(8).gap(9).rounded(7).items_center()
        .when(i === this.at, el => el.bg(t.selected))
        .on_mouse_move((e, cx) => {
          if (item === GROUP) this.showGroup(e.bounds);
          else if (this.at !== i) { this.at = i; cx.notify(); }
        })
        .on_click((e, cx) => this.choose(item, cx, e.bounds))
        .when(item === GROUP, el => el.child(svg(`${ICONS}/folder.svg`).size(14).flex_none().text_color(t.muted)))
        .child(div().flex_1().min_w(0).truncate().child(item.label))
        .when(item === GROUP, el => el.child(svg(`${ICONS}/chevron-right.svg`).size(12).flex_none().text_color(t.muted)))));
  }
}
