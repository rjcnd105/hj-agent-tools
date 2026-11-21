import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Load the mod's ESM as-is on Node 20, without a package.json in the mod folder.
const source = await readFile(new URL("../../herdr/hj-changes/model.js", import.meta.url));
const { MAIN, projectSlug, parseSession, parseMeta, promptWorktree, parseWorktreeList, worktreeTargets, visibleTargets, pickTarget, countEntries } =
  await import(`data:text/javascript;base64,${source.toString("base64")}`);

const meta = (fields) => JSON.stringify({ agentType: "general-purpose", spawnDepth: 1, ...fields });

test("project slug replaces every non-alphanumeric character", () => {
  assert.equal(projectSlug("/Users/hj/study/hj-agent-tools"), "-Users-hj-study-hj-agent-tools");
  assert.equal(projectSlug("/Users/hj/Library/Mobile Documents/iCloud~md~obsidian/Documents/Brain"),
    "-Users-hj-Library-Mobile-Documents-iCloud-md-obsidian-Documents-Brain");
});

test("session file gives the session id and its start folder", () => {
  assert.deepEqual(parseSession('{"pid":1,"sessionId":"abc","cwd":"/repo","status":"busy"}'), { sessionId: "abc", cwd: "/repo" });
  assert.equal(parseSession(null), null);
  assert.equal(parseSession("{"), null);
  assert.equal(parseSession('{"sessionId":"abc"}'), null);
});

test("meta: Claude's worktree, running until finished; a team member is never running", () => {
  // Unreadable or half-written: undefined, so the panel reads it again.
  assert.equal(parseMeta("agent-a1.meta.json", '{"worktreePath":"/w'), undefined);
  assert.equal(parseMeta("agent-a1.meta.json", null), undefined);
  assert.equal(parseMeta("agent-a1.meta.json", "null"), undefined);
  assert.deepEqual(parseMeta("agent-abc3c3f724b51dd8b.meta.json", meta({ worktreePath: "/repo.agent-abc", spawnedWithWorktree: true, name: "wt-probe" })),
    { path: "/repo.agent-abc", label: "wt-probe", running: true, agentId: "abc3c3f724b51dd8b" });
  assert.equal(parseMeta("agent-a1.meta.json", meta({ worktreePath: "/w", finished: true })).running, false);
  assert.deepEqual(parseMeta("agent-a1.meta.json", meta({ description: "plain" })), { path: null, label: "plain", running: true, agentId: "a1" });
  assert.equal(parseMeta("agent-aie-1303-x.meta.json", meta({ name: "ie-1303", taskKind: "in_process_teammate", worktreePath: null })).running, false);
});

test("prompt names one worktree: longest path first, no partial names, none when several", () => {
  const paths = ["/repo.feature-PSR-1303-ie-티켓-요청-정보", "/repo.feature-PSR-1305-회수", "/repo.a", "/repo.a-2"];
  assert.equal(promptWorktree("Work only in `/repo.feature-PSR-1303-ie-티켓-요청-정보`. Branch: feature/PSR-1303.", paths), "/repo.feature-PSR-1303-ie-티켓-요청-정보");
  assert.equal(promptWorktree('{"content":"cd /repo.a-2/src && edit"}', paths), "/repo.a-2");
  assert.equal(promptWorktree("see /repo.ab/x", paths), null);
  assert.equal(promptWorktree("compare /repo.a and /repo.feature-PSR-1305-회수", paths), null);
  assert.equal(promptWorktree("research only", paths), null);
  assert.equal(promptWorktree("", paths), null);
});

test("meta label falls back to a short description, then the agent id", () => {
  assert.equal(parseMeta("agent-a1.meta.json", meta({ worktreePath: "/w", description: "Fix login" })).label, "Fix login");
  assert.equal(parseMeta("agent-a1.meta.json", meta({ worktreePath: "/w", description: "Refactor the whole payment flow" })).label, "Refactor the whole paym…");
  assert.equal(parseMeta("agent-0123456789ab.meta.json", meta({ worktreePath: "/w" })).label, "01234567");
});

test("worktree list keeps branches and drops prunable entries", () => {
  const map = parseWorktreeList([
    "worktree /repo", "HEAD c1b4662", "detached", "",
    "worktree /repo.agent-a", "HEAD c1b4662", "branch refs/heads/agent-a", "",
    "worktree /repo.agent-gone", "HEAD c1b4662", "branch refs/heads/agent-gone", "prunable gitdir file points to non-existent location", "",
  ].join("\n"));
  assert.deepEqual([...map], [["/repo", { branch: null }], ["/repo.agent-a", { branch: "agent-a" }]]);
});

test("targets keep live worktrees once, in meta order", () => {
  const worktrees = new Map([["/repo", { branch: null }], ["/w1", { branch: "agent-1" }], ["/w2", { branch: "agent-2" }]]);
  const metas = [
    { path: "/w2", label: "two", running: true, agentId: "2" },
    { path: "/gone", label: "gone", running: false, agentId: "3" },
    { path: "/w1", label: "one", running: false, agentId: "1" },
    { path: "/w2", label: "dup", running: false, agentId: "4" },
  ];
  assert.deepEqual(worktreeTargets(metas, worktrees).map((t) => [t.path, t.label, t.branch, t.rank]),
    [["/w2", "two", "agent-2", 0], ["/w1", "one", "agent-1", 1]]);
});

test("visible targets: every live one, running first, then newest", () => {
  const targets = [
    { path: "/new-done", running: false, rank: 0 },
    { path: "/run-clean", running: true, rank: 1 },
    { path: "/committed", running: false, rank: 2 },
    { path: "/status-failed", running: false, rank: 3 },
  ];
  const visible = visibleTargets(targets, { "/new-done": 2, "/run-clean": 0, "/committed": 0, "/status-failed": null });
  assert.deepEqual(visible.map((t) => [t.path, t.count]), [["/run-clean", 0], ["/new-done", 2], ["/committed", 0], ["/status-failed", null]]);
});

test("pick honours the user's choice while shown, else the first worktree with something to see, else main", () => {
  const visible = [{ path: "/clean", running: false, count: 0 }, { path: "/a", running: false, count: 3 }, { path: "/b", running: false, count: 1 }];
  assert.equal(pickTarget(visible, "/b"), "/b");
  assert.equal(pickTarget(visible, "/clean"), "/clean");
  assert.equal(pickTarget(visible, MAIN), MAIN);
  assert.equal(pickTarget(visible, "/gone"), "/a");
  assert.equal(pickTarget(visible, null), "/a");
  assert.equal(pickTarget([{ path: "/run", running: true, count: 0 }], null), "/run");
  assert.equal(pickTarget([{ path: "/clean", running: false, count: 0 }], null), MAIN);
  assert.equal(pickTarget([], "/a"), MAIN);
});

test("status entries are counted from -z output", () => {
  assert.equal(countEntries(""), 0);
  assert.equal(countEntries(" M a.txt\0?? b.txt\0"), 2);
});
