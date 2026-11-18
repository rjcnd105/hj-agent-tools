import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Load the mod's ESM as-is on Node 20, without a package.json in the mod folder.
const source = await readFile(new URL("../../external/herdr-mods/hj-team/model.js", import.meta.url));
const {
  availableParents, buildLaunchArgs, buildModelSyncPrompt, describeRoleCommand, formatValidationError, groupRuns, newPresetSkeleton,
  pickDefaultParent, resolveSpaceCwd, sortAndFilterPresets,
} = await import(`data:text/javascript;base64,${source.toString("base64")}`);

const terminal = (address, fields = {}) => ({ address, state: "live", ...fields });
const teamLabels = (runId, fields = {}) => ({
  "hc.team.run": runId, "hc.team.preset": "web-squad", "hc.team.cwd": "/work/web", ...fields,
});

test("groups live role and server terminals by run and parses the sender's last message", () => {
  const withParent = { "hc.team.parent": "t114" };
  const runs = groupRuns([
    terminal("t01"),
    terminal("t03", { labels: teamLabels("run001", { ...withParent, "hc.team.server": "web" }) }),
    terminal("t04", { status: "working", labels: teamLabels("run001", { ...withParent,
      "hc.team.role": "dev", "hc.team.last": "handoff|web-qa|Ready on port 3000" }) }),
    terminal("t05", { status: "blocked", labels: teamLabels("run001", { ...withParent, "hc.team.role": "reviewer" }) }),
    terminal("t06", { labels: teamLabels("run002", { "hc.team.role": "dev", "hc.team.last": "malformed" }) }),
    terminal("t07", { state: "exited", labels: teamLabels("stale1", { "hc.team.role": "dev" }) }),
    terminal("t08", { state: "exited", labels: teamLabels("run001", { "hc.team.role": "old-dev" }) }),
    terminal("vps/t04", { labels: teamLabels("run001", { "hc.team.role": "remote-dev" }) }),
    terminal("vps/t09", { labels: teamLabels("remote", { "hc.team.server": "remote-web" }) }),
  ]);
  assert.deepEqual(runs, [
    { runId: "run001", presetId: "web-squad", cwd: "/work/web", parent: "t114",
      roles: [
        { id: "dev", address: "t04", status: "working", last: { kind: "handoff", to: "web-qa", summary: "Ready on port 3000" } },
        { id: "reviewer", address: "t05", status: "blocked", last: null },
      ], servers: [{ id: "web", address: "t03", status: null, last: null }] },
    { runId: "run002", presetId: "web-squad", cwd: "/work/web", parent: null,
      roles: [{ id: "dev", address: "t06", status: null, last: null }], servers: [] },
  ]);
});

const local = { id: "web", tabs: [{ id: "main" }, { id: "qa" }] };
const elsewhere = { id: "native", tabs: [{ id: "other" }] };
const remote = { id: "vps/web", tabs: [{ id: "vps/other" }] };
const pane = (address, tab) => ({ pane: `p-${address}`, terminal: address, tab });
const agent = (address, fields = {}) => terminal(address, { program: { agent: true }, ...fields });
const fish = terminal("tfish", { program: { key: "shell", name: "fish", agent: false, shell: true } });
const zsh = terminal("tzsh", { program: { key: "shell", name: "zsh", agent: false, shell: true } });
const allPanes = [pane("tfish", "main"), pane("tzsh", "other"), pane("t11", "main"), pane("t12", "qa"), pane("t13", "qa"), pane("t14", "qa"), pane("vps/t11", "vps/other")];
const allTerminals = [fish, zsh, agent("t11"), agent("t12"), agent("t13", { state: "exited" }),
  agent("t14", { program: { agent: true, shell: true } }), agent("t15", { parent: "t11" }),
  agent("vps/t11"), agent("vps/t12", { labels: { "herdr.space": "web" } }),
  agent("t16", { labels: { "herdr.space": "web" } }), agent("t17", { parent: "t18" }), agent("t18", { parent: "t17" })];

test("defaults to the focused agent in the active space, otherwise the first eligible agent", () => {
  const pick = focus => pickDefaultParent(local, allPanes, allTerminals, focus);
  assert.equal(pick({ space: "web", terminal: "t12" }), "t12");
  assert.equal(pick({ space: "web", terminal: "t15" }), "t15");
  assert.equal(pick({ space: "web", terminal: "tfish" }), "t11");
  assert.equal(pick({ space: "web", terminal: "t14" }), "t11");
  assert.equal(pick({ space: "vps/web", terminal: "vps/t11" }), "t11");
  assert.equal(pick(null), "t11");
});

test("shell-only and absent spaces yield no parent even if another space has agents", () => {
  assert.equal(pickDefaultParent(elsewhere, allPanes, allTerminals, { space: "native", terminal: "tzsh" }), null);
  assert.equal(pickDefaultParent(null, allPanes, allTerminals, { terminal: "t12" }), null);
});

test("lists only live agents belonging to the active space, including parked descendants", () => {
  assert.deepEqual(availableParents(local, allPanes, allTerminals).map(t => t.address), ["t11", "t12", "t15", "t16"]);
  assert.deepEqual(availableParents(remote, allPanes, allTerminals).map(t => t.address), ["vps/t11", "vps/t12"]);
  assert.deepEqual(availableParents(elsewhere, allPanes, allTerminals), []);
});

test("resolves cwd only from the active local tab, then the space folder", () => {
  const space = { ...local, folder: "/space-root", tabs: [{ id: "main" }, { id: "qa", active: true }] };
  const projectPanes = [
    { ...pane("t11", "main"), cwd: "/wrong-repo" },
    { ...pane("t12", "qa"), cwd: "/active-first" },
    { ...pane("t13", "qa"), cwd: "/active-focused" },
    { ...pane("t14", "qa"), cwd: null },
  ];
  const focus = (address, tab = "qa", id = "web") => ({ ...pane(address, tab), space: id });
  assert.equal(resolveSpaceCwd(space, projectPanes, focus("t13")), "/active-focused");
  assert.equal(resolveSpaceCwd(space, projectPanes, focus("t14")), "/active-first");
  assert.equal(resolveSpaceCwd(space, projectPanes, focus("t11", "main")), "/active-first");
  assert.equal(resolveSpaceCwd(space, projectPanes, focus("t13", "qa", "elsewhere")), "/active-first");
  assert.equal(resolveSpaceCwd(space, projectPanes.slice(0, 1), null), "/space-root");
  assert.equal(resolveSpaceCwd(local, projectPanes, focus("t11", "main")), null);
  assert.equal(resolveSpaceCwd({ ...space, folder: "" }, [], null), null);
  assert.equal(resolveSpaceCwd({ ...space, machine: "vps" }, projectPanes, focus("t13")), null);
  assert.equal(resolveSpaceCwd(null, projectPanes, focus("t13")), null);
});

test("sorts presets by overlay, descending last-use time and alphabetical name without mutation", () => {
  const presets = [
    { id: "zebra", name: "Zebra" }, { id: "alpha", name: "Alpha" }, { id: "recent", name: "Recent" },
    { id: "overlay-a", name: "Overlay A", hasOverlay: true }, { id: "overlay-b", name: "Overlay B", hasOverlay: true },
  ];
  const sorted = sortAndFilterPresets(presets, { recent: 9000, "overlay-b": 2000 }, "");
  assert.deepEqual(sorted.map(entry => entry.id), ["overlay-b", "overlay-a", "recent", "alpha", "zebra"]);
  assert.deepEqual(presets.map(entry => entry.id), ["zebra", "alpha", "recent", "overlay-a", "overlay-b"]);
  assert.deepEqual(sortAndFilterPresets([{ id: "constructor", name: "A" }, presets[2]], { recent: 9000 }, "").map(entry => entry.id),
    ["recent", "constructor"]);
});

test("filters case-insensitively by preset id, name, description, or merged role id and title", () => {
  const target = {
    id: "full-stack", name: "Delivery team", description: "Ships search changes",
    preset: { roles: [{ id: "web-qa", title: "Browser Reviewer" }] },
  };
  const other = { id: "native", name: "Native", preset: { roles: [{ id: "dev", title: "Developer" }] } };
  for (const query of ["LL-ST", "LIVERY", "SEARCH", "B-QA", " BROWSER "]) {
    assert.deepEqual(sortAndFilterPresets([other, target], {}, query), [target]);
  }
  assert.deepEqual(sortAndFilterPresets([target, other], {}, "missing"), []);
});

test("builds exact launch argv with explicit parent choice and no shell escaping", () => {
  assert.deepEqual(buildLaunchArgs({
    presetId: "web-squad", cwd: "/work/my repo", parent: "t114", selectedRoles: ["qa", "dev"],
    task: 'Verify "search" & confirm', withServers: true,
  }), ["launch", "web-squad", "--json", "--cwd", "/work/my repo", "--parent", "t114", "--roles", "qa,dev", '--task=Verify "search" & confirm', "--with-servers"]);
  assert.deepEqual(buildLaunchArgs({ presetId: "web-squad", cwd: "/work/web", task: "--help" }),
    ["launch", "web-squad", "--json", "--cwd", "/work/web", "--no-parent", "--task=--help"]);
  assert.deepEqual(buildLaunchArgs({ presetId: "web-squad", cwd: "/work/web", parent: null, selectedRoles: ["dev"], task: "", withServers: false }),
    ["launch", "web-squad", "--json", "--cwd", "/work/web", "--no-parent", "--roles", "dev"]);
  assert.deepEqual(buildLaunchArgs({ presetId: "web-squad", cwd: "/work/web", parent: null }),
    ["launch", "web-squad", "--json", "--cwd", "/work/web", "--no-parent"]);
});

test("describes mixed harness commands without treating unknown executables as a known agent", () => {
  assert.deepEqual(describeRoleCommand(["/opt/bin/claude", "--model=opus", "--effort", "high"]),
    { executable: "/opt/bin/claude", name: "Claude", icon: "claude", model: "opus · high" });
  assert.deepEqual(describeRoleCommand(["codex", "-m", "gpt-5", "-c", 'model_reasoning_effort="xhigh"']),
    { executable: "codex", name: "Codex", icon: "codex", model: "gpt-5 · xhigh" });
  assert.deepEqual(describeRoleCommand(["pi", "--provider", "openai", "--model", "gpt-6.2-sol", "--thinking=high"]),
    { executable: "pi", name: "Pi", icon: "pi", model: "openai · gpt-6.2-sol · high" });
  assert.deepEqual(describeRoleCommand(["agy"]), { executable: "agy", name: "Antigravity", icon: "antigravity", model: "" });
  assert.deepEqual(describeRoleCommand(["C:\\bin\\custom-cli"]),
    { executable: "C:\\bin\\custom-cli", name: "custom-cli", icon: null, model: "" });
});

test("describes an unresolved route without requiring a command", () => {
  assert.deepEqual(describeRoleCommand(undefined, "unknown route: deep-review"),
    { executable: "", name: "Unresolved", icon: null, model: "", error: "unknown route: deep-review" });
  assert.equal(describeRoleCommand([]).error, "Role command is unavailable.");
});

test("creates a fresh, schema-v1 preset with a runnable default role", () => {
  const first = newPresetSkeleton();
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.equal(first.schemaVersion, 1);
  assert.match(first.id, /^[a-z0-9][a-z0-9-]{0,31}$/);
  assert.ok(first.name.length > 0 && first.name.length <= 80);
  assert.equal(first.roles.length, 1);
  const [role] = first.roles;
  assert.match(role.id, /^(?!parent$)[a-z0-9][a-z0-9_-]{0,23}$/);
  assert.ok(role.title.length > 0 && role.title.length <= 60);
  assert.deepEqual(role.command, ["pi"]);
  assert.equal(role.default, true);
  assert.ok(role.instructions.trim());
  assert.deepEqual(role.talksTo, []);
  role.command.push("--test");
  assert.deepEqual(newPresetSkeleton().roles[0].command, ["pi"]);
});

test("extracts stderr or stdout validation issues by JSON Pointer and keeps plain diagnostics", () => {
  const validation = JSON.stringify({ error: { message: "Invalid preset", issues: [
    { path: "/roles/0/command", message: "must contain an executable" }, { path: "", message: "unexpected key" },
  ] } });
  const expected = "Invalid preset\n/roles/0/command: must contain an executable\n/: unexpected key";
  assert.equal(formatValidationError(validation, ""), expected);
  assert.equal(formatValidationError("warning from stderr", validation), expected);
  assert.equal(formatValidationError("", '{"error":{"message":"Already exists"}}'), "Already exists");
  assert.equal(formatValidationError(" not installed\n", ""), "not installed");
  assert.equal(formatValidationError("", " missing overlay \n"), "missing overlay");
  assert.equal(formatValidationError("", ""), "hc-team failed without diagnostics.");
});

test("builds a model sync prompt for the focused agent and ignores empty input", () => {
  assert.equal(buildModelSyncPrompt({ request: "   ", modelsPath: "/p/_models.md", routesPath: "/p/_routes.json" }), null);
  const prompt = buildModelSyncPrompt({
    request: "pi - deepseek 4.1 추가해줘",
    modelsPath: "/Users/hj/.agents/presets/_models.md",
    routesPath: "/Users/hj/.agents/presets/_routes.json",
  });
  assert.match(prompt, /pi - deepseek 4\.1 추가해줘/);
  assert.match(prompt, /\/Users\/hj\/\.agents\/presets\/_models\.md/);
  assert.match(prompt, /\/Users\/hj\/\.agents\/presets\/_routes\.json/);
});
