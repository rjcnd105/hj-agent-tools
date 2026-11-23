import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Load the mod's ESM as-is on Node 20, without a package.json in the mod folder.
const source = await readFile(new URL("../../herdr/hj-agents/model.js", import.meta.url));
const { buildAgentRows, buildShellServerGroups, countServerRows, openUrlCommand, shortUrl, worktreeName } =
  await import(`data:text/javascript;base64,${source.toString("base64")}`);

const terminal = (address, fields = {}) => ({ address, state: "live", ...fields });
const server = (port, fields = {}) => ({ port, url: `http://localhost:${port}`, ...fields });
const space = (id, folder, fields = {}) => ({ id, folder, ...fields });

test("parent, sibling and deeper sub-session servers share the same tree", () => {
  const all = [
    terminal("t114"),
    terminal("t21", { name: "gmn-2094", parent: "t114" }),
    terminal("t22", { name: "gmn-2004", parent: "t114" }),
    terminal("t23", { parent: "t21" }),
    terminal("t24", { parent: "t114", state: "exited" }),
  ];
  const servers = {
    t114: [server(4431), server(4437, { url: "https://local.gentlemonster.com:4437" })],
    t21: [server(8000)],
    t22: [server(8001)],
    t23: [server(8002)],
    t24: [server(8003)],
  };
  const rows = buildAgentRows("t114", all, servers, new Set());
  assert.deepEqual(rows.map((r) => [r.kind, r.t?.address ?? r.ownerAddr, r.srv?.port ?? null, r.lines]), [
    ["server", "t114", 4431, ["├"]],
    ["server", "t114", 4437, ["├"]],
    ["sub", "t21", null, ["├"]],
    ["server", "t21", 8000, ["│", "├"]],
    ["sub", "t23", null, ["│", "└"]],
    ["server", "t23", 8002, ["│", "", "└"]],
    ["sub", "t22", null, ["└"]],
    ["server", "t22", 8001, ["", "└"]],
  ]);
  assert.equal(rows[1].srv.url, "https://local.gentlemonster.com:4437");
  assert.equal(rows.filter((r) => r.kind === "sub").length, 3);
});

test("the default cap is three per owner; expanding one leaves the others capped", () => {
  const all = [terminal("t21", { parent: "t114" })];
  const servers = {
    t114: [server(3000), server(3001), server(3002), server(3003), server(3004)],
    t21: [server(4000), server(4001), server(4002), server(4003)],
  };
  const collapsed = buildAgentRows("t114", all, servers, new Set());
  assert.deepEqual(collapsed.filter((r) => r.kind === "more"), [
    { kind: "more", ownerKey: "t114", remaining: 2, lines: ["├"] },
    { kind: "more", ownerKey: "t21", remaining: 1, lines: ["", "└"] },
  ]);
  const expanded = buildAgentRows("t114", all, servers, new Set(["t21"]));
  assert.deepEqual(expanded.filter((r) => r.kind === "more").map((r) => r.ownerKey), ["t114"]);
  assert.deepEqual(expanded.filter((r) => r.ownerAddr === "t21").map((r) => r.srv.port), [4000, 4001, 4002, 4003]);
  assert.deepEqual(expanded.at(-1).lines, ["", "└"]);
  assert.equal(expanded.filter((r) => r.kind === "sub").length, 1);
});

test("live shells not rendered in the agent tree are grouped by label or cwd", () => {
  const spaces = [space("gm", "/work/gm"), space("app", "/work/gm/app/")];
  const all = [
    terminal("parent"),
    terminal("child", { parent: "parent" }),
    terminal("grandchild", { parent: "child" }),
    terminal("t4z", { name: "fish", cwd: "/work/gm/app", labels: { "herdr.space": "gm" } }),
    terminal("cwd-shell", { cwd: "/work/gm/app/pkg" }),
    terminal("outside", { cwd: "/work/gm-old" }),
    terminal("exited", { state: "exited", cwd: "/work/gm" }),
    terminal("no-server", { cwd: "/work/gm" }),
  ];
  const servers = Object.fromEntries(all.slice(0, -1).map((t) => [t.address, [server(4437), server(4438)]]));
  const groups = buildShellServerGroups(all, new Set(["parent"]), spaces, servers, [], new Set(["t4z"]), 1);
  assert.deepEqual(groups.map((g) => [g.space?.id ?? null, g.owners.map((o) => o.ownerKey)]), [
    ["gm", ["t4z"]],
    ["app", ["cwd-shell"]],
    [null, ["outside"]],
  ]);
  assert.equal(groups[0].owners[0].label, "fish · t4z");
  assert.deepEqual(groups[0].owners[0].rows.map((r) => [r.kind, r.ownerAddr, r.lines]), [
    ["server", "t4z", ["├"]],
    ["server", "t4z", ["└"]],
  ]);
  assert.deepEqual(groups[1].owners[0].rows.at(-1), { kind: "more", ownerKey: "cwd-shell", remaining: 1, lines: ["└"] });
});

test("detached listeners use the longest local space folder, including equal paths", () => {
  const spaces = [
    space("gm", "/work/gm"),
    space("app", "/work/gm/app/"),
    space("remote", "/work/gm/app/sub", { machine: "vps" }),
  ];
  const detached = [
    server(3000, { cwd: "/work/gm", pid: 4 }),
    server(3001, { cwd: "/work/gm/app", pid: 5 }),
    server(3002, { cwd: "/work/gm/app/sub/pkg", pid: 6 }),
    server(3003, { cwd: "/work/gm-old", pid: 7 }),
    server(3004, { pid: 8 }),
  ];
  const groups = buildShellServerGroups([], [], spaces, {}, detached, new Set(), 1);
  assert.deepEqual(groups.map((g) => [g.space.id, g.owners[0].label]), [["gm", "Detached"], ["app", "Detached"]]);
  assert.deepEqual(groups.map((g) => g.owners[0].rows[0].ownerAddr), [null, null]);
  assert.deepEqual(groups.map((g) => g.owners[0].rows[0].srv.port), [3000, 3001]);
  assert.deepEqual(groups[1].owners[0].rows.at(-1), {
    kind: "more", ownerKey: "detached-app", remaining: 1, lines: ["└"],
  });
  const expanded = buildShellServerGroups([], [], spaces, {}, detached, new Set(["detached-app"]), 1);
  assert.deepEqual(expanded[1].owners[0].rows.map((r) => r.srv.port), [3001, 3002]);
});

test("detached listeners can match a labeled live terminal's cwd without a space folder", () => {
  const labels = { "herdr.space": "app" };
  const terminals = [
    terminal("agent", { cwd: "/repo", labels }),
    terminal("shell", { cwd: "/other", labels }),
    terminal("old", { cwd: "/old", labels, state: "exited" }),
    terminal("vps/t1", { cwd: "/remote", labels }),
    terminal("unlabeled", { cwd: "/elsewhere" }),
  ];
  const detached = ["/repo", "/repo/pkg", "/other/pkg", "/repo-old", "/old", "/remote", "/elsewhere"]
    .map((cwd, i) => server(3000 + i, { cwd }));
  const groups = buildShellServerGroups(terminals, ["agent"], [space("app", "")], {}, detached, new Set());
  assert.deepEqual(groups.map((g) => [g.space.id, g.owners[0].label]), [["app", "Detached"]]);
  assert.deepEqual(groups[0].owners[0].rows.map((r) => r.srv.port), [3000, 3001, 3002]);
});

test("the Servers block counts space and owner headings plus visible rows", () => {
  const terminals = [terminal("shell", { cwd: "/app" }), terminal("other", { cwd: "/other" })];
  const spaces = [space("app", "/app"), space("other", "/other")];
  const servers = { shell: [server(3000)], other: [server(3001)] };
  const detached = [4000, 4001, 4002, 4003, 4004].map((port) => server(port, { cwd: "/app" }));
  assert.equal(countServerRows([]), 0);
  const capped = buildShellServerGroups(terminals, [], spaces, servers, detached, new Set());
  assert.equal(countServerRows(capped), 11); // 2 spaces, 3 owners, 5 URLs, 1 "more".
  const all = buildShellServerGroups(terminals, [], spaces, servers, detached, new Set(), Infinity);
  assert.equal(countServerRows(all), 12); // 2 spaces, 3 owners, 7 URLs.
});

test("platform commands keep the full URL, including scheme and port", () => {
  const url = "https://productservice-local.systemiic.com:4437";
  assert.deepEqual(openUrlCommand("macos", url), { cmd: "open", args: [url] });
  assert.deepEqual(openUrlCommand("linux", url), { cmd: "xdg-open", args: [url] });
  assert.deepEqual(openUrlCommand("windows", url), { cmd: "cmd", args: ["/c", "start", "", url] });
  assert.equal(shortUrl(` ${url} `), url);
});

test("a linked worktree is named by its folder without the repository's name", () => {
  const parse = (...lines) => worktreeName(`${lines.join("\n")}\n`);
  // A linked worktree's git dir is under the repository's `worktrees`.
  assert.equal(parse("/w/repo/.git/worktrees/repo.feature-x", "/w/repo/.git", "/w/repo.feature-x"), "feature-x");
  assert.equal(parse("/w/repo/.git/worktrees/agent-a1", "/w/repo/.git", "/w/repo/.claude/worktrees/agent-a1"), "agent-a1");
  // "repository" only starts with "repo": nothing to drop.
  assert.equal(parse("/w/repo/.git/worktrees/repository", "/w/repo/.git", "/w/repository"), "repository");
  assert.equal(parse("/w/repo.git/worktrees/main", "/w/repo.git", "/w/repo-main"), "main");
  // The repository's own checkout, a submodule, and no repository at all.
  assert.equal(parse("/w/repo/.git", "/w/repo/.git", "/w/repo"), null);
  assert.equal(parse("/w/repo/.git/modules/lib", "/w/repo/.git/modules/lib", "/w/repo/lib"), null);
  assert.equal(worktreeName(""), null);
});
