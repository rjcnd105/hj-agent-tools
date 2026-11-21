import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const [menuSource, filesSource, configSource] = await Promise.all(
  ["hj-menu/main.js", "hj-files/main.js", "lib/mod-config.js"].map((path) =>
    readFile(new URL(`../../herdr/${path}`, import.meta.url), "utf8")),
);
const { createModConfig } = await import(`data:text/javascript,${encodeURIComponent(configSource)}`);
const configDir = "/home/test user/.herdr/hj-menu";
const configPath = `${configDir}/editors.json`;
const cwd = "/repo with spaces";
const folder = "nested/한글 folder";
const position = { x: 60, y: 90 };
const editorConfig = (count) => JSON.stringify({ editors: Array.from({ length: count }, (_, i) => ({
  label: `Editor ${i}`, bundle: `local.test.editor${i}`,
})) });

// Drive the actual view callbacks without macOS, GPUI, a user's config, or launching an editor.
function harness({ text = editorConfig(2), read = () => text } = {}) {
  const rows = new Map(), live = new Map(), jobs = [], overlays = [], commands = [], writes = [], reads = [], reveals = [];
  let props, list, inLayout = false, releases = 0, machine = null;
  const cx = { focus_handle: () => ({ focus() {} }), bind_keys() {}, notify() {}, stop_propagation() {}, spawn(fn) { jobs.push(fn(cx)); } };
  function element() {
    const el = new Proxy({ events: {} }, { get(target, method) {
      if (method in target) return target[method];
      if (method === "id") return (id) => { rows.set(id, el); return el; };
      if (method === "when") return (condition, fn) => condition ? fn(el) : el;
      if (typeof method === "string" && method.startsWith("on_")) return (...args) => {
        assert.equal(inLayout, false, "GPUI forbids event registration in a virtual row renderer");
        target.events[method] = args.at(-1);
        return el;
      };
      return () => el;
    } });
    return el;
  }
  function closeOverlay(id) {
    const view = live.get(id);
    live.delete(id);
    view?.close();
  }
  const host = {
    createModConfig, View: class {}, div: element, svg: element, h_flex: element, v_flex: element,
    Scrollbar: { vertical: element }, VirtualListScrollHandle: { new: () => ({
      scroll_to_item: (i) => reveals.push(i), release() { releases++; },
    }) },
    v_virtual_list(_id, count, _height, _key, render) {
      list = Object.assign(element(), { count, renderVisible(range) {
        inLayout = true;
        try { return render(range); } finally { inLayout = false; }
      } });
      return list;
    },
    home: () => "/home/test user", props: () => props, theme: () => ({}), checking: () => false,
    settings: () => ({ zoom: 1 }),
    window: Object.assign(() => ({ platform: "macos" }), {
      mouse_position: () => position, viewport_size: () => ({ width: 1000, height: 800 }),
    }),
    spaces: () => [{ id: "work", active: true, folder: cwd, machine }],
    panes: () => [], focused: () => ({ pane: "p0", cwd }), notify() {},
    async readTextFile(path) { reads.push(path); return read(); },
    async writeTextFile(path, value, expected) { writes.push({ path, value, expected }); text = value; },
    async exec(command, args) {
      commands.push([command, ...args]);
      return { code: command === "/usr/bin/printenv" ? 1 : 0, stdout: "", stderr: "" };
    },
    openOverlay(spec) { const id = `popup-${overlays.length}`; overlays.push({ id, ...spec }); return id; }, closeOverlay,
  };
  // Herdr supplies these native imports. Inject only their stand-ins and the real config helper.
  const load = (source, exports, filename) => runInNewContext(
    source.replace(/^import .*;\n/gm, "").replace("export default class ", "class ") + `\n${exports}`, { ...host }, { filename },
  );
  const Menu = load(menuSource, "FileMenu", "hj-menu/main.js");
  const mount = (data) => {
    props = data;
    const view = new Menu();
    view.init(null, cx);
    live.set(data.overlay, view);
    return view;
  };
  return {
    cx, live, closeOverlay, overlays, commands, writes, reads, reveals, rows,
    get list() { return list; }, get releases() { return releases; },
    mountRoot: (path = `${cwd}/${folder}`) => mount({ overlay: "root", path }),
    mountLast: () => { const { id, props: data } = overlays.at(-1); return mount({ overlay: id, ...data }); },
    loadFiles: () => load(filesSource, "({ Files, key })", "hj-files/main.js"),
    remote: () => { machine = "other-machine"; },
    async settle() { while (jobs.length) await jobs.shift(); },
  };
}

function hoverOpenWith(h, root) {
  root.render();
  h.rows.get("row-0").events.on_mouse_move({ bounds: { ...position, width: 140 } }, h.cx);
}

test("hover coalesces a pending config read and reopening the child reuses the snapshot", async () => {
  let finishRead;
  const pending = new Promise((resolve) => { finishRead = resolve; });
  const h = harness({ read: () => pending });
  const root = h.mountRoot();
  root.render();
  const hover = h.rows.get("row-0").events.on_mouse_move;
  for (let i = 0; i < 1000; i++) hover({ bounds: { ...position, width: 140 } }, h.cx);
  finishRead(editorConfig(2));
  await h.settle();
  assert.deepEqual(h.reads, [configPath]);
  assert.equal(h.overlays.length, 1);

  h.mountLast().key({ key: "left" }, h.cx);
  assert.deepEqual([...h.live.keys()], ["root"]);
  root.key({ key: "right" }, h.cx);
  await h.settle();
  h.mountLast();
  assert.deepEqual(h.reads, [configPath]);
  h.closeOverlay("root");
  assert.equal(h.live.size, 0);
});

test("closing the parent while settings load does not resurrect a submenu", async () => {
  let finishRead;
  const h = harness({ read: () => new Promise((resolve) => { finishRead = resolve; }) });
  hoverOpenWith(h, h.mountRoot());
  // Let the async env lookup enter the read before shutting the popup.
  await new Promise(setImmediate);
  assert.equal(typeof finishRead, "function");
  h.closeOverlay("root");
  finishRead(editorConfig(2));
  await h.settle();
  assert.equal(h.overlays.length, 0);
});

test("long lists virtualize just the editors and keyboard navigation wraps through Config", async () => {
  const h = harness({ text: editorConfig(60) });
  hoverOpenWith(h, h.mountRoot());
  await h.settle();
  const sub = h.mountLast();
  sub.render();
  assert.equal(h.list.count, 60);
  assert.equal(h.list.renderVisible({ start: 58, end: 60 }).length, 2);
  sub.key({ key: "up" }, h.cx); // first editor → Config, which is not a scroll index
  assert.deepEqual(h.reveals, []);
  sub.key({ key: "up" }, h.cx); // Config → last editor
  assert.deepEqual(h.reveals, [59]);
  sub.key({ key: "down" }, h.cx);
  sub.key({ key: "enter" }, h.cx);
  await h.settle();
  assert.deepEqual(h.commands.at(-1), ["/usr/bin/open", "-t", configPath]);
  assert.equal(h.live.size, 0);
  assert.equal(h.releases, 1);
});

test("clicking Config creates a missing file, but leaves a malformed user file intact", async () => {
  for (const text of [null, "{ bad JSON"]) {
    const h = harness({ text });
    hoverOpenWith(h, h.mountRoot());
    await h.settle();
    const sub = h.mountLast();
    sub.render();
    h.rows.get(`row-${sub.items.length - 1}`).events.on_click({}, h.cx);
    await h.settle();
    assert.deepEqual(h.commands.at(-1), ["/usr/bin/open", "-t", configPath]);
    assert.equal(h.writes.length, text === null ? 1 : 0);
    if (text === null) {
      const [write] = h.writes;
      assert.equal(write.expected, null);
      assert.equal(write.path, configPath);
      assert.ok(JSON.parse(write.value).editors.length);
    }
    assert.equal(h.live.size, 0);
  }
});

test("Files opens the right-clicked folder as one argv entry and leaves left-click as toggle", async () => {
  const h = harness();
  const { Files, key } = h.loadFiles();
  const files = new Files(), toggled = [];
  Object.assign(files, {
    root: cwd, context: { key: key(), cwd, on: null }, marks: {}, folders: new Set(),
    entries: new Map([["nested", [{ name: "한글 folder", dir: true }]]]), toggle: (path) => toggled.push(path),
  });
  files.rows("nested", 1, [], {});
  const events = h.rows.get(`file-${folder}`).events;
  events.on_click({}, h.cx);
  assert.deepEqual(toggled, [folder]);
  assert.equal(h.overlays.length, 0);
  events.on_mouse_down({ position }, h.cx);
  assert.equal(h.overlays.at(-1).mod, "hj-menu");
  h.remote();
  events.on_mouse_down({ position }, h.cx); // stale row from the previous local context
  assert.equal(h.overlays.length, 1);

  const root = h.mountLast();
  root.key({ key: "right" }, h.cx);
  await h.settle();
  h.mountLast().key({ key: "enter" }, h.cx);
  await h.settle();
  assert.deepEqual(h.commands.at(-1), ["/usr/bin/open", "-b", "local.test.editor0", `${cwd}/${folder}`]);
  assert.equal(h.live.size, 0);
});
