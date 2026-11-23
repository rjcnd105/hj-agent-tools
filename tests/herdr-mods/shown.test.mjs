import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../../herdr/lib/shown.js", import.meta.url));
const { shownIn } = await import(`data:text/javascript;base64,${source.toString("base64")}`);

const block = (id, mod, extra = {}) => ({ id, type: "block", content: { mod }, ...extra });
const tree = (panel = {}, stack = {}) => ({
  id: "root", type: "row", children: [
    block("agents", "hj-agents"),
    { id: "panel", type: "column", ...panel, children: [
      { id: "panel-body", type: "stack", ...stack, children: [block("files", "hj-files"), block("changes", "hj-changes")] },
    ] },
  ],
});

test("a block shows only when no ancestor hides it and each stack shows its child", () => {
  assert.equal(shownIn(tree({}, { active: "changes" }), "hj-changes"), true);
  assert.equal(shownIn(tree({}, { active: "changes" }), "hj-files"), false);
  // A stack without `active` shows its first child.
  assert.equal(shownIn(tree(), "hj-files"), true);
  assert.equal(shownIn(tree(), "hj-changes"), false);
  assert.equal(shownIn(tree({ hidden: true }, { active: "changes" }), "hj-changes"), false);
  assert.equal(shownIn(tree({ hidden: true }), "hj-agents"), true);
});

test("a mod the layout doesn't place, or an unreadable layout, counts as shown", () => {
  assert.equal(shownIn(tree({ hidden: true }), "hj-pane"), true);
  assert.equal(shownIn(null, "hj-changes"), true);
  assert.equal(shownIn({ id: "root", type: "row", children: [null, 3] }, "hj-changes"), true);
  // Shown when any of its blocks shows.
  const two = { id: "root", type: "row", children: [block("a", "hj-changes", { hidden: true }), block("b", "hj-changes")] };
  assert.equal(shownIn(two, "hj-changes"), true);
});
