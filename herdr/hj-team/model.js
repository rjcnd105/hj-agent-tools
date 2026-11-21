// Herdr snapshots and hc-team CLI argv, with no UI or process dependencies.

function parseLast(value) {
  if (typeof value !== "string") return null;
  const [kind, to, ...summary] = value.split("|");
  return kind && to && summary.length ? { kind, to, summary: summary.join("|") } : null;
}

export function groupRuns(allTerminals) {
  const runs = new Map();
  for (const terminal of allTerminals) {
    const labels = terminal.labels;
    const runId = labels?.["hc.team.run"];
    if (terminal.state !== "live" || terminal.address.includes("/") || !runId) continue;
    if (!runs.has(runId)) runs.set(runId, {
      runId, presetId: labels["hc.team.preset"] ?? null, cwd: labels["hc.team.cwd"] ?? null,
      parent: labels["hc.team.parent"] ?? null, roles: [], servers: [],
    });
    const run = runs.get(runId);
    const role = labels["hc.team.role"], server = labels["hc.team.server"];
    const row = { address: terminal.address, status: terminal.status ?? null, last: parseLast(labels["hc.team.last"]) };
    if (role) run.roles.push({ id: role, ...row });
    else if (server) run.servers.push({ id: server, ...row });
  }
  return [...runs.values()];
}

export function availableParents(activeSpace, allPanes, allTerminals) {
  if (!activeSpace) return [];
  const tabs = new Set(activeSpace.tabs.map(tab => tab.id));
  const paneByAddress = new Map(allPanes.filter(pane => pane.terminal).map(pane => [pane.terminal, pane]));
  const live = allTerminals.filter(terminal => terminal.state === "live");
  const byAddress = new Map(live.map(terminal => [terminal.address, terminal]));
  // Parked agents without their own layout labels still belong to their parent's space.
  function inSpace(terminal) {
    const seen = new Set();
    while (terminal && !seen.has(terminal.address)) {
      seen.add(terminal.address);
      const pane = paneByAddress.get(terminal.address);
      if (pane) return tabs.has(pane.tab);
      const label = terminal.labels?.["herdr.space"];
      if (label) {
        const slash = terminal.address.indexOf("/");
        return (slash === -1 ? label : terminal.address.slice(0, slash + 1) + label) === activeSpace.id;
      }
      terminal = byAddress.get(terminal.parent);
    }
    return false;
  }
  return live.filter(terminal => terminal.program?.agent && !terminal.program.shell && inSpace(terminal));
}

export function pickDefaultParent(activeSpace, allPanes, allTerminals, focusedInfo) {
  const candidates = availableParents(activeSpace, allPanes, allTerminals);
  const localFocus = !focusedInfo?.space || focusedInfo.space === activeSpace?.id;
  return (localFocus && candidates.find(terminal => terminal.address === focusedInfo?.terminal)?.address) ||
    candidates[0]?.address || null;
}

export function resolveSpaceCwd(space, allPanes, focusedInfo) {
  if (!space || space.machine || space.id.includes("/")) return null;
  const tab = space.tabs.find(tab => tab.active);
  const panes = tab ? allPanes.filter(pane => pane.tab === tab.id) : [];
  const focusedPane = focusedInfo?.space === space.id && focusedInfo.tab === tab?.id
    ? panes.find(pane => pane.pane === focusedInfo.pane) : null;
  return (focusedPane ?? panes.find(pane => pane.focused))?.cwd
    || panes.find(pane => pane.cwd)?.cwd || space.folder || null;
}

export function sortPresets(presets, lastUsedMap = {}) {
  const lastUsed = id => Object.hasOwn(lastUsedMap, id) ? lastUsedMap[id] ?? 0 : 0;
  return [...presets].sort((a, b) => Number(Boolean(b.hasOverlay)) - Number(Boolean(a.hasOverlay))
    || lastUsed(b.id) - lastUsed(a.id)
    || a.name.localeCompare(b.name));
}

export function buildLaunchArgs({ presetId, cwd, parent, selectedRoles, task, withServers }) {
  return [
    "launch", presetId, "--json", "--cwd", cwd, ...(parent ? ["--parent", parent] : ["--no-parent"]),
    ...(selectedRoles?.length ? ["--roles", selectedRoles.join(",")] : []),
    ...(task ? [`--task=${task}`] : []), ...(withServers ? ["--with-servers"] : []),
  ];
}

export function describeRoleCommand(command, routeError) {
  const executable = command?.[0];
  if (routeError || !executable) return {
    executable: "", name: "Unresolved", icon: null, model: "", error: routeError || "Role command is unavailable.",
  };
  const basename = executable.split(/[\\/]/).pop();
  const harness = {
    claude: ["Claude", "claude"], codex: ["Codex", "codex"], pi: ["Pi", "pi"],
    agy: ["Antigravity", "antigravity"],
  };
  const [name, icon] = Object.hasOwn(harness, basename) ? harness[basename] : [basename, null];
  const model = [];
  for (let i = 1; i < command.length; i++) {
    const arg = command[i];
    if (/^(?:--(?:provider|model|thinking|effort)|-m)$/.test(arg) && command[i + 1]) model.push(command[++i]);
    else if (/^--(?:provider|model|thinking|effort)=/.test(arg)) model.push(arg.slice(arg.indexOf("=") + 1));
    else if (arg.startsWith("model_reasoning_effort=")) model.push(arg.slice(arg.indexOf("=") + 1).replace(/["']/g, ""));
  }
  return { executable, name, icon, model: model.join(" · ") };
}

export function newPresetSkeleton() {
  return {
    schemaVersion: 1, id: "new-team", name: "New Team", description: "", servers: [],
    roles: [{
      id: "dev", title: "Developer", command: ["pi"], default: true, readOnly: false,
      skills: [], owns: [], talksTo: [], checkpoints: [],
      instructions: "Implement the assigned task and report the result.",
    }],
  };
}

export function buildModelSyncPrompt({ request, modelsPath, routesPath }) {
  const trimmed = String(request ?? "").trim();
  if (!trimmed) return null;
  return [
    `[hc-team model sync] 요청: ${trimmed}`,
    `대상 파일:`,
    `- 수집된 모델 프로파일: ${modelsPath || "~/.herdr/hj-team/_models.md"}`,
    `- 공통 역할 모델 라우팅: ${routesPath || "~/.herdr/hj-team/_routes.json"}`,
    `절차:`,
    `1. 로컬 CLI(pi --list-models, agy models, claude/codex --help 등)로 실제 사용 가능한 모델과 플래그를 확인한다.`,
    `2. 웹 검색으로 최신 커뮤니티 평가·강점·약점을 날짜와 함께 조사해 _models.md에 추가 또는 갱신한다.`,
    `3. 공통 역할 라우팅(_routes.json) 변경이 필요하면 route별 이전->이후 변경안과 영향 역할(hc-team routes)을 제안하고, 승인 후 hc-team routes save로 저장한다.`,
  ].join("\n");
}

export function formatValidationError(stderr, stdout) {
  for (const output of [stderr, stdout]) {
    try {
      const error = JSON.parse(output)?.error;
      if (!error?.message) continue;
      const issues = Array.isArray(error.issues) ? error.issues : [];
      return [error.message, ...issues.map(issue => `${issue.path || "/"}: ${issue.message}`)].join("\n");
    } catch { /* Non-JSON diagnostics are used below. */ }
  }
  return stderr?.trim() || stdout?.trim() || "hc-team failed without diagnostics.";
}
