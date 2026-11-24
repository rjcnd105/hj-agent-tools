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

export function pickFocusedParent(activeSpace, allPanes, allTerminals, focusedInfo) {
  const candidates = availableParents(activeSpace, allPanes, allTerminals);
  const localFocus = !focusedInfo?.space || focusedInfo.space === activeSpace?.id;
  if (localFocus && focusedInfo) {
    const pane = focusedInfo.pane ? allPanes.find(p => p.pane === focusedInfo.pane) : null;
    for (const addr of [focusedInfo.shown, focusedInfo.terminal, focusedInfo.agent, pane?.terminal]) {
      if (addr && candidates.some(terminal => terminal.address === addr)) return addr;
    }
  }
  const activeTab = activeSpace?.tabs?.find(tab => tab.active);
  if (activeTab) {
    const activePane = allPanes.find(p => p.tab === activeTab.id && p.focused);
    if (activePane?.terminal && candidates.some(terminal => terminal.address === activePane.terminal)) {
      return activePane.terminal;
    }
  }
  return null;
}

export function pickDefaultParent(activeSpace, allPanes, allTerminals, focusedInfo, fallback = null) {
  const candidates = availableParents(activeSpace, allPanes, allTerminals);
  return pickFocusedParent(activeSpace, allPanes, allTerminals, focusedInfo)
    || (fallback && candidates.find(terminal => terminal.address === fallback)?.address)
    || candidates[0]?.address || null;
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

export function buildLaunchArgs({ presetId, cwd, parent, selectedRoles, roleCounts, task, withServers, runId, notifyParent }) {
  const roleTokens = (selectedRoles ?? []).map(id => {
    const count = Number(roleCounts?.[id] ?? 1);
    return count > 1 ? `${id}=${count}` : id;
  });
  return [
    "launch", presetId, "--json", "--cwd", cwd,
    ...(runId ? ["--run", runId] : parent ? ["--parent", parent] : ["--no-parent"]),
    ...(roleTokens.length ? ["--roles", roleTokens.join(",")] : []),
    ...(task ? [`--task=${task}`] : []), ...(withServers ? ["--with-servers"] : []),
    ...(notifyParent ? ["--notify-parent"] : []),
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
      skills: [], tools: [], owns: [], talksTo: [], checkpoints: [],
      instructions: "Implement the assigned task and report the result.",
    }],
  };
}

function sameCommand(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

export function preparePresetForEdit(globalPreset, routes = {}) {
  const autoCommands = {};
  if (!globalPreset || typeof globalPreset !== "object" || !Array.isArray(globalPreset.roles)) {
    return { doc: globalPreset, autoCommands };
  }
  const doc = {
    ...globalPreset,
    roles: globalPreset.roles.map(role => {
      if (!role || typeof role !== "object" || !role.route || Object.hasOwn(role, "command")) return role;
      const routeCmd = Object.hasOwn(routes, role.route) ? routes[role.route]?.command : null;
      if (!Array.isArray(routeCmd)) return role;
      if (typeof role.id === "string") autoCommands[role.id] = { route: role.route, command: [...routeCmd] };
      const expanded = {};
      for (const [key, value] of Object.entries(role)) {
        expanded[key] = value;
        if (key === "route") expanded.command = [...routeCmd];
      }
      return expanded;
    }),
  };
  return { doc, autoCommands };
}

export function formatCommandInput(argv) {
  if (!Array.isArray(argv)) return "";
  if (argv.some(part => /[\r\n\t]/.test(String(part)))) return JSON.stringify(argv);
  return argv.map(part => {
    const str = String(part);
    if (!str || /[\s"'\\]/.test(str)) return JSON.stringify(str);
    return str;
  }).join(" ");
}

export function parseCommandInput(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch { /* Fall through to token parsing. */ }
  }
  const tokens = [];
  let cur = "", quote = null, escaped = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) {
      if (quote === '"') {
        if (ch === "n") cur += "\n";
        else if (ch === "r") cur += "\r";
        else if (ch === "t") cur += "\t";
        else cur += ch;
      } else {
        cur += ch;
      }
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { tokens.push(cur); cur = ""; }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

export function splitCsv(text) {
  return String(text ?? "").split(",").map(item => item.trim()).filter(Boolean);
}

export function splitLines(text) {
  return String(text ?? "").split(/\r?\n/).map(item => item.trim()).filter(Boolean);
}

export function presetToFormDraft(preset, routes = {}) {
  const routeNames = Object.keys(routes).sort();
  const fallbackRoute = routeNames[0] ?? "";
  return {
    schemaVersion: 1,
    id: preset?.id ?? "new-team",
    name: preset?.name ?? "New Team",
    description: preset?.description ?? "",
    servers: (preset?.servers ?? []).map(srv => ({
      id: srv?.id ?? "web",
      commandText: formatCommandInput(srv?.command ?? []),
      cwd: srv?.cwd ?? ".",
    })),
    roles: (preset?.roles ?? []).map(role => {
      const hasCommand = Array.isArray(role?.command) && !role?.route;
      return {
        id: role?.id ?? "role",
        title: role?.title ?? "",
        mode: hasCommand ? "command" : "route",
        route: role?.route ?? fallbackRoute,
        commandText: formatCommandInput(role?.command ?? (role?.route && routes?.[role.route]?.command ? routes[role.route].command : [])),
        default: role?.default !== false,
        readOnly: Boolean(role?.readOnly),
        scalable: Boolean(role?.scalable),
        worktree: Boolean(role?.worktree),
        ownServer: Boolean(role?.ownServer),
        skillsText: (role?.skills ?? []).join(", "),
        toolsText: (role?.tools ?? []).join("\n"),
        owns: [...(role?.owns ?? [])],
        talksTo: [...(role?.talksTo ?? [])],
        checkpoints: [...(role?.checkpoints ?? [])],
        instructions: role?.instructions ?? "",
      };
    }),
  };
}

export function formDraftToPreset(draft) {
  const servers = (draft?.servers ?? []).map(srv => ({
    id: String(srv.id ?? "").trim(),
    command: parseCommandInput(srv.commandText),
    ...(String(srv.cwd ?? "").trim() && String(srv.cwd).trim() !== "." ? { cwd: String(srv.cwd).trim() } : {}),
  }));
  const roles = (draft?.roles ?? []).map(role => {
    const id = String(role.id ?? "").trim();
    const out = {
      id,
      title: String(role.title ?? "").trim(),
      ...(role.mode === "command"
        ? { command: parseCommandInput(role.commandText) }
        : { route: String(role.route ?? "").trim() }),
      default: Boolean(role.default),
      ...(role.readOnly ? { readOnly: true } : {}),
      ...(role.scalable ? { scalable: true } : {}),
      ...(role.worktree ? { worktree: true } : {}),
      ...(role.ownServer ? { ownServer: true } : {}),
    };
    const skills = splitCsv(role.skillsText);
    const tools = splitLines(role.toolsText);
    if (skills.length) out.skills = skills;
    if (tools.length) out.tools = tools;
    if (role.owns?.length) out.owns = [...role.owns];
    if (role.talksTo?.length) out.talksTo = [...role.talksTo];
    if (role.checkpoints?.length) out.checkpoints = [...role.checkpoints];
    out.instructions = String(role.instructions ?? "").trim();
    return out;
  });
  return {
    schemaVersion: 1,
    id: String(draft?.id ?? "").trim(),
    name: String(draft?.name ?? "").trim(),
    ...(String(draft?.description ?? "").trim() ? { description: String(draft.description).trim() } : {}),
    ...(servers.length ? { servers } : {}),
    roles,
  };
}

export function normalizePresetFromEdit(rawText, routes = {}, autoCommands = {}) {
  let doc;
  try { doc = JSON.parse(rawText); } catch { return rawText; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(doc.roles)) return rawText;
  doc.roles = doc.roles.map(role => {
    if (!role || typeof role !== "object" || Array.isArray(role)) return role;
    if (!Object.hasOwn(role, "route") || !Object.hasOwn(role, "command")) return role;
    const orig = typeof role.id === "string" && Object.hasOwn(autoCommands, role.id) ? autoCommands[role.id] : null;
    const routeCmd = typeof role.route === "string" && Object.hasOwn(routes, role.route) ? routes[role.route]?.command : null;
    const next = { ...role };
    if (sameCommand(role.command, orig?.command) || sameCommand(role.command, routeCmd)) delete next.command;
    else delete next.route;
    return next;
  });
  return JSON.stringify(doc, null, 2);
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

export function buildPresetEditPrompt({ presetId, presetName, presetsDir, overlayDir, request }) {
  const trimmed = String(request ?? "").trim();
  if (!trimmed || !presetId) return null;
  const globalPath = `${(presetsDir || "~/.herdr/hj-team").replace(/\/+$/, "")}/${presetId}.json`;
  return [
    `[hc-team preset edit] 프리셋: ${presetName ? `${presetName} (${presetId})` : presetId}`,
    `요청: ${trimmed}`,
    `대상 경로:`,
    `- 전역 프리셋: ${globalPath}`,
    ...(overlayDir ? [`- 프로젝트 오버레이(프로젝트 전용 규칙/스크립트용): ${overlayDir}`] : []),
    `원칙:`,
    `1. 전역 프리셋에는 특정 프로젝트·브랜치·브랜드·레포 전용 스크립트·세션 메모리 의존 내용을 넣지 않는다.`,
    `2. 전역 수정은 \`hc-team preset get ${presetId} --json\`으로 읽은 뒤 \`hc-team preset save --stdin --update\`로 스키마 검증과 함께 저장한다.`,
    `3. 현재 프로젝트에만 해당하는 규칙·명령·URL은 프로젝트 오버레이(\`docs/agent-presets/${presetId}/\`)에 반영한다.`,
  ].join("\n");
}

export function buildMachineSetupPrompt({ machinePath, presetsDir } = {}) {
  return [
    `[hc-team machine setup] 이 컴퓨터의 hc-team 머신별 로컬 설정을 점검하고 세팅해줘.`,
    `대상 파일:`,
    `- 머신 로컬 설정(동기화 제외): ${machinePath || "~/.config/hc-team/machine.json"}`,
    `- 전역 프리셋/라우트: ${presetsDir || "~/.herdr/hj-team"}`,
    `절차:`,
    `1. \`hc-team machine show --json\`으로 현재 라우트·프리셋이 참조하는 실행 파일과 누락 항목을 확인한다.`,
    `2. 이 컴퓨터에 실제 설치된 에이전트 바이너리 경로(claude, codex, pi, agy, hc 등)를 확인한다. 가능하면 mise/asdf 심보다 실제 설치 바이너리 경로를 우선 잡는다.`,
    `3. 비로그인 GUI(Herdr/launchd/systemd) 환경에서 필요한 필수 환경변수가 있다면 \`env\`에 기록한다.`,
    `4. \`hc-team machine save --stdin\`(또는 \`hc-team machine detect --write\`)으로 저장하고, 최소 PATH 환경(\`PATH=/usr/bin:/bin hc-team launch <preset> --dry-run --json\`)으로 정상 해석되는지 검증한다.`,
  ].join("\n");
}

export function buildOnboardingPrompt({ presetsDir, machinePath } = {}) {
  const dir = presetsDir || "~/.herdr/hj-team";
  return [
    `[hc-team onboarding] 내 환경과 워크플로우에 맞게 ${dir} 의 팀 프리셋·모델 라우팅·도구 플레이북을 초기 세팅해줘.`,
    `대상 경로:`,
    `- 사용자 팀 설정 폴더: ${dir} (_routes.json, _models.md, _tools.md, <preset>.json)`,
    `- 머신 로컬 실행 경로 설정: ${machinePath || "~/.config/hc-team/machine.json"}`,
    `절차:`,
    `1. 이 컴퓨터에 실제 설치된 에이전트 CLI(claude, codex, pi, agy 등)와 주요 로컬 도구·스킬(브라우저 QA, PR CLI, VCS 등)을 먼저 확인한다.`,
    `2. 나에게 주로 하는 작업 유형, 선호하는 에이전트·모델 조합, 자주 쓰는 CLI/스크립트를 짧게 확인한다.`,
    `3. 설치된 에이전트만으로 \`_routes.json\`(\`hc-team routes save --stdin\`)과 맞춤 프리셋(\`hc-team preset save --stdin\`), 반복 시행착오 방지용 \`_tools.md\`, 그리고 \`hc-team machine detect --write\`를 구성하고 \`--dry-run\`으로 검증한다.`,
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
