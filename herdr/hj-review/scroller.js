// A scrolling list the mod draws itself: only the items on screen are built, like a virtual list,
// but as ordinary elements, so rows keep their own press, drag and hover handlers (the app's
// virtual lists refuse them). The wheel and the thumb move it; code sets `top`.
// Adapted from herdr-review-pane's scroller, from herdr-gitview (github.com/ChmaraX/herdr-gitview, MIT).
import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { settings } from "herdr";

const BAR = 6;

// Sizes, pointer positions and wheel deltas arrive in zoomed px; heights and offsets are layout px.
export function unzoom(px) {
  const z = Number(settings().zoom);
  return Number.isFinite(z) && z > 0 ? px / z : px;
}

export class Scroller {
  // `horizontal`: wheel and trackpad also move `left`, a sideways offset over `content` px that the
  // owner applies to whatever should move sideways; the vertical thumb stays put.
  // `onResize({ width, shorter }, cx)` runs when the view changes size: `width` when it changed,
  // `shorter` when the view lost height (a box opened under it).
  constructor(id, { horizontal = false, onResize = null } = {}) {
    this.id = id; this.horizontal = horizontal; this.onResize = onResize;
    this.top = 0; this.height = 0; this.left = 0; this.width = 0; this.content = 0;
    this.floor = 0;
    this.sizes = []; this.offsets = [0];
    this.dragging = null;
  }

  // Item heights; `floorAt` is an item whose top may scroll to the top of the view even past the end.
  measure(sizes, floorAt = -1) {
    const offsets = new Array(sizes.length + 1);
    offsets[0] = 0;
    for (let i = 0; i < sizes.length; i++) offsets[i + 1] = offsets[i] + sizes[i];
    this.sizes = sizes; this.offsets = offsets; this.floor = offsets[floorAt] ?? 0;
    this.clamp();
  }

  total() { return this.offsets[this.offsets.length - 1]; }
  max() { return Math.max(0, this.total() - this.height, Math.min(this.floor, this.total())); }
  clamp() { this.top = Math.max(0, Math.min(this.top, this.max())); }
  clampX() { this.left = Math.max(0, Math.min(this.left, this.content - this.width)); }

  setTop(px) { const before = this.top; this.top = px; this.clamp(); return this.top !== before; }
  setContent(px) { this.content = px; this.clampX(); }

  // The item at `y` px below the top of the view, or -1.
  indexAt(y) {
    const at = this.top + y;
    let lo = 0, hi = this.sizes.length - 1;
    if (hi < 0 || at < 0 || at >= this.total()) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid] <= at) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  // The fewest pixels that bring item i into view.
  reveal(i, margin = 0) {
    const a = this.offsets[i], b = this.offsets[i + 1];
    if (a === undefined || !this.height) return false;
    if (a - margin < this.top) return this.setTop(a - margin);
    if (b + margin > this.top + this.height) return this.setTop(b + margin - this.height);
    return false;
  }

  // The items in view: [start, end).
  visible() {
    const n = this.sizes.length, start = Math.max(0, this.indexAt(0));
    let end = start;
    while (end < n && this.offsets[end] < this.top + (this.height || 1200)) end++;
    return [start, end];
  }

  thumb(t, axis, pos, size, start) {
    const e = div().id(`${this.id}-thumb-${axis}`).absolute().rounded(3).bg(t.border).hover((s) => s.bg(t.muted))
      .on_mouse_down("left", (ev, cx) => { this.dragging = start(ev); cx.stop_propagation(); });
    return axis === "x" ? e.bottom(1).left(pos).h(BAR).w(size) : e.right(1).top(pos).w(BAR).h(size);
  }

  // `render(i)` builds item i; `overlay` draws over the items (a pinned header).
  view(t, render, overlay = null) {
    const [start, end] = this.visible();
    const items = [];
    for (let i = start; i < end; i++) items.push(render(i));
    const span = this.max(), over = span > 0 && this.height > 0;
    const thumb = over ? Math.max(24, this.height * this.height / (span + this.height)) : 0;
    const thumbTop = over ? (this.height - thumb) * this.top / span : 0;
    const spanX = this.content - this.width, overX = this.horizontal && spanX > 1 && this.width > 0;
    const thumbX = overX ? Math.max(24, this.width * this.width / this.content) : 0;
    const thumbLeft = overX ? (this.width - thumbX) * this.left / spanX : 0;
    return div().id(this.id).relative().flex_1().min_h(0).w_full().overflow_hidden()
      .on_size_change((size, cx) => {
        const height = unzoom(size.height), width = unzoom(size.width);
        if (height === this.height && width === this.width) return;
        const change = { width: width !== this.width, shorter: height < this.height };
        this.height = height; this.width = width;
        this.clamp(); this.clampX();
        this.onResize?.(change, cx);
        cx.notify();
      })
      .on_scroll_wheel((e, cx) => {
        const top = this.top, left = this.left;
        const dx = unzoom(e.delta.x ?? 0), dy = unzoom(e.delta.y ?? 0);
        // Shift turns a mouse wheel sideways where the host leaves the amount on y (macOS moves it to x).
        if (this.horizontal && e.modifiers?.shift && dx === 0) this.left -= dy;
        // Whichever axis dominates, so a straight swipe doesn't drift.
        else if (this.horizontal && Math.abs(dx) > Math.abs(dy)) this.left -= dx;
        else this.top -= dy;
        this.clamp(); this.clampX();
        if (this.top !== top || this.left !== left) cx.notify();
      })
      .on_mouse_move((e, cx) => {
        const d = this.dragging;
        if (!d) return;
        if (d.axis === "x") { this.left = d.from + unzoom(e.position.x - d.at) * spanX / Math.max(1, this.width - thumbX); this.clampX(); }
        else { this.top = d.from + unzoom(e.position.y - d.at) * span / Math.max(1, this.height - thumb); this.clamp(); }
        cx.notify();
      })
      .on_mouse_up("left", () => { this.dragging = null; })
      .child(v_flex().absolute().left(0).right(0).top(this.offsets[start] - this.top).children(items))
      .when(Boolean(overlay), (e) => e.child(overlay))
      .when(over, (e) => e.child(this.thumb(t, "y", thumbTop, thumb, (ev) => ({ axis: "y", at: ev.position.y, from: this.top }))))
      .when(overX, (e) => e.child(this.thumb(t, "x", thumbLeft, thumbX, (ev) => ({ axis: "x", at: ev.position.x, from: this.left }))));
  }
}
