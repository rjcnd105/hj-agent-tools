// In your personal Herdr layout, add this block to `panel-body.children`:
//   { "id": "teams", "type": "block", "content": { "mod": "hj-team" } }
// The hj-tabs bar then adds Teams beside Files and Changes; leave workspace.panels alone.
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex, Button, InputState, Input, EditorState, Editor, Scrollbar } from "gpui-base";
import {
  checking, closeOverlay, exec, focused, hc, home, layout, openOverlay, panes, props, readTextFile, run,
  setShared, settings, shared, spaces, terminals, theme, watchFolder,
} from "herdr";
import {
  availableParents, buildLaunchArgs, buildMachineSetupPrompt, buildModelSyncPrompt, buildOnboardingPrompt, buildPresetEditPrompt, describeRoleCommand, formatValidationError, groupRuns, newPresetSkeleton,
  normalizePresetFromEdit, pickDefaultParent, preparePresetForEdit, resolveSpaceCwd, sortPresets,
} from "./model.js";
// Copied from herdr/lib/mod-config.js by `just herdr-mods`.
import { createModConfig, expandHome, posInt } from "./mod-config.js";
import { shownIn } from "./shown.js";

const SELECT = "hj-team.select";
const REVISION = "hj-team.presets-revision";
const LAST_USED = "lastUsed";
const DEFAULT_CONFIG = {
  hcTeamBin: null,
  presetTimeoutMs: 8000,
  stopTimeoutMs: 60000,
  launchTimeoutMs: 240000,
  visiblePresetRows: 3,
};
const modConfig = createModConfig({
  mod: "hj-team",
  envVars: ["HERDR_MOD_HJ_TEAM_DIR", "HC_TEAM_PRESETS_DIR"],
  file: "_config.json",
  defaults: DEFAULT_CONFIG,
  validate(parsed) {
    return {
      hcTeamBin: typeof parsed?.hcTeamBin === "string" && parsed.hcTeamBin.trim() ? parsed.hcTeamBin.trim() : null,
      presetTimeoutMs: posInt(parsed?.presetTimeoutMs, DEFAULT_CONFIG.presetTimeoutMs, 1000),
      stopTimeoutMs: posInt(parsed?.stopTimeoutMs, DEFAULT_CONFIG.stopTimeoutMs, 5000),
      launchTimeoutMs: posInt(parsed?.launchTimeoutMs, DEFAULT_CONFIG.launchTimeoutMs, 10000),
      visiblePresetRows: Math.min(12, posInt(parsed?.visiblePresetRows, DEFAULT_CONFIG.visiblePresetRows, 1)),
    };
  },
  home, exec, readTextFile, checking,
});
let teamConfig = { ...DEFAULT_CONFIG };
let bin;
let initialConfigPromise = null;

async function reloadTeamConfig(cx) {
  const { dir, config } = await modConfig.loadSafe();
  if (JSON.stringify(config) !== JSON.stringify(teamConfig)) {
    teamConfig = config;
    bin = null;
    cx?.notify?.();
  }
  return dir;
}

function ensureTeamConfig(cx) {
  if (!initialConfigPromise) initialConfigPromise = reloadTeamConfig(cx);
  return initialConfigPromise;
}

async function team(args, timeout) {
  if (checking()) return;
  await ensureTeamConfig();
  const effectiveTimeout = timeout ?? teamConfig.presetTimeoutMs;
  if (teamConfig.hcTeamBin) {
    return exec(expandHome(teamConfig.hcTeamBin, home()), args, { timeout: effectiveTimeout });
  }
  // Resolve before running anything that mutates state; never retry a timed-out launch.
  bin ??= exec("which", ["hc-team"], { timeout: teamConfig.presetTimeoutMs })
    .then(result => result.code === 0 && result.stdout.trim() || `${home()}/.local/bin/hc-team`)
    .catch(() => `${home()}/.local/bin/hc-team`);
  const hcTeamBin = await bin;
  return exec(hcTeamBin, args, { timeout: effectiveTimeout });
}

function expectSuccess(result) {
  if (result.code !== 0) throw new Error(formatValidationError(result.stderr, result.stdout));
  return result;
}
const message = error => error?.message ?? String(error);
const parseResult = result => JSON.parse(expectSuccess(result).stdout);

function action(t, id, label, click, { selected = false, primary = false, danger = false, disabled = false } = {}) {
  return Button.new(id).flex().h(28).px(8).gap(4).min_w(0).items_center().justify_center().rounded(6)
    .border_1().border_color(selected ? t.input : t.border).bg(primary && !disabled ? t.solid : selected ? t.selected : t.raised)
    .text_color(disabled ? t.dim : primary ? t.solid_foreground : danger ? t.ansi1 : t.foreground)
    .text_size(12).when(primary || selected, el => el.font_semibold()).selected(selected).disabled(disabled)
    .when(!disabled, el => el.cursor_pointer().hover(s => primary ? s.opacity(0.88) : s.bg(t.hover))
      .active(s => s.opacity(0.75)).focus(s => s.border_color(t.working)).on_click(click))
    .child(typeof label === "string" ? div().min_w(0).truncate().child(label) : label);
}
const badge = (t, label, color = t.muted) => div().flex_none().rounded(8).px(6).bg(t.selected).text_size(11).text_color(color).child(label);
const meta = (t, label) => div().text_size(12).text_color(t.muted).child(label);
const caption = (t, label) => div().text_size(11).font_semibold().text_color(t.muted).child(label);
const chips = () => h_flex().gap(4).flex_wrap();
const card = t => v_flex().gap(8).p(12).rounded(8).bg(t.chrome).border_1().border_color(t.border);
const panelBody = id => v_flex().id(id).flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(12);

function statusMark(t, status) {
  if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
  if (status === "blocked" || status === "error") return div().size(14).flex_none().rounded(4).bg(t.blocked + "26")
    .text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
  return div().size(7).mx(3).flex_none().rounded(4)
    .when(status === "idle", el => el.border(1.5).border_color(t.idle ?? t.dim))
    .when(status === "done", el => el.bg(t.done));
}

function harnessBadge(t, { name, icon }, count = 1) {
  return h_flex().flex_none().items_center().gap(4).rounded(8).px(6).bg(t.selected).text_size(11).text_color(t.foreground)
    .when(Boolean(icon), el => el.child(image(`icons/${icon}.svg`).size(12).flex_none()))
    .child(count > 1 ? `${name} ×${count}` : name);
}

export default class Team extends View {
  init(_props, cx) {
    this.error = null;
    const p = props();
    if (p?.dialog) {
      if (p.dialog === "edit" || p.dialog === "routes") {
        const t = theme();
        const syntax = { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 };
        if (p.dialog === "edit" && !p.isNew) {
          this.origId = p.preset.id;
          this.origSha = p.globalSha;
        }
        let doc = p.dialog === "routes" ? p.doc : p.preset;
        if (p.dialog === "edit") {
          const prepared = p.isNew ? { doc: p.preset, autoCommands: {} } : preparePresetForEdit(p.preset, p.routes ?? {});
          doc = prepared.doc;
          this.autoCommands = prepared.autoCommands;
        }
        this.editor = EditorState.new({ language: "json", value: JSON.stringify(doc, null, 2),
          font_family: settings().font_family, font_size: 12, syntax });
        if (p.dialog === "routes") {
          this.modelsSection = "routes";
          this.modelsEditor = EditorState.new({ language: "markdown", value: p.modelsText ?? "",
            font_family: settings().font_family, font_size: 12, syntax });
          this.machineEditor = EditorState.new({ language: "json", value: JSON.stringify(p.machineConfig ?? { schemaVersion: 1, executables: {}, path: [], env: {} }, null, 2),
            font_family: settings().font_family, font_size: 12, syntax });
          this.syncInput = InputState.new({ placeholder: "예: claude 6 추가 / pi - deepseek 4.1 조사해서 반영해줘" });
          this.syncInput.on("submit", (_event, cx) => this.syncModels(cx));
          this.syncTarget = p.syncTarget ?? null;
          this.syncNotice = null;
          this.syncing = false;
        }
      } else if (p.dialog === "edit-agent") {
        this.agentPromptInput = InputState.new({ placeholder: "예: reviewer 빼고 qa에 모바일 체크 추가해줘" });
        this.agentPromptInput.on("submit", (_event, cx) => this.sendPresetEdit(cx));
        this.syncTarget = p.syncTarget ?? null;
        this.syncNotice = null;
        this.syncing = false;
      }
      return;
    }
    this.tab = "presets";
    this.presets = [];
    this.presetsDir = null;
    this.projectRoot = null;
    this.presetErrors = [];
    this.roles = new Set();
    this.lastUsed = {};
    this.selectSignal = this.pendingSelection = shared(SELECT) ?? null;
    this.revision = shared(REVISION);
    if (checking()) return;
    try { this.lastUsed = JSON.parse(localStorage.getItem(LAST_USED)) ?? {}; } catch { /* Ignore invalid storage. */ }
    cx.spawn(async cx => {
      const dir = await ensureTeamConfig(cx);
      this.watchDirectory("presetWatch", dir, cx);
    });
  }

  watchDirectory(slot, dir, cx) {
    if (checking() || props()?.dialog || this[slot]?.dir === dir) return;
    const previous = this[slot];
    const watch = this[slot] = dir ? { dir } : null;
    previous?.pending?.cancel();
    if (watch) this.runWatch(slot, watch, cx);
  }

  // The loop parks, holding no watch and no timer, while the Team block is hidden and when the
  // folder can't be watched (it doesn't exist yet, or no watch was free). wakeWatches() resumes it
  // from render.
  runWatch(slot, watch, cx) {
    watch.parked = 0;
    cx.spawn(async cx => {
      let failed = false;
      try {
        while (this[slot] === watch && shownIn(layout(), "hj-team")) {
          watch.pending = watchFolder(watch.dir);
          const paths = await watch.pending;
          if (this[slot] !== watch) return;
          if (!paths.length) { failed = true; break; }
          if (slot === "presetWatch") await reloadTeamConfig(cx);
          this.refresh(cx);
        }
      } catch { failed = true; }
      if (this[slot] === watch) Object.assign(watch, { pending: null, parked: Date.now(), failed });
    });
  }

  // A watch parked while hidden resumes at once and reloads what changed meanwhile. A failed one
  // checks at most every 30 seconds whether its folder exists now, with one `test`, not a refresh.
  wakeWatches(cx) {
    for (const slot of ["presetWatch", "overlayWatch"]) {
      const watch = this[slot];
      if (!watch?.parked || (watch.failed && Date.now() - watch.parked < 30000)) continue;
      const failed = watch.failed;
      if (failed) watch.parked = Date.now();
      else this.runWatch(slot, watch, cx);
      cx.spawn(async cx => {
        if (failed) {
          if ((await exec("test", ["-d", watch.dir]).catch(() => null))?.code !== 0) return;
          if (this[slot] !== watch || !watch.parked) return;
          this.runWatch(slot, watch, cx);
        }
        if (slot === "presetWatch") await reloadTeamConfig(cx);
        this.refresh(cx);
      });
    }
  }

  syncPresets(space, allPanes, cx) {
    const cwd = resolveSpaceCwd(space, allPanes, focused());
    const key = JSON.stringify([space?.id, cwd]);
    let changed = false;
    if (this.context?.key !== key) {
      this.context = { key, cwd };
      this.watchDirectory("overlayWatch", null, cx);
      this.parentOverride = undefined;
      this.presets = [];
      this.presetErrors = [];
      this.listError = null;
      this.notice = null;
      changed = true;
    }
    const select = shared(SELECT) ?? null, revision = shared(REVISION);
    if (select !== this.selectSignal || (revision?.count !== this.revision?.count && revision?.saved)) {
      this.selectSignal = select;
      this.pendingSelection = select;
      changed = true;
    }
    if (revision?.count !== this.revision?.count) {
      this.revision = revision;
      changed = true;
    }
    if (changed) this.refresh(cx);
  }

  refresh(cx) {
    if (checking() || props()?.dialog || !this.context) return;
    const context = this.context;
    if (context.loading) { context.reload = true; return; }
    context.loading = true;
    cx.spawn(async cx => {
      do {
        context.reload = false;
        const cwdArgs = context.cwd ? ["--cwd", context.cwd] : [];
        const [list, routes, machine] = await Promise.allSettled([
          team(["preset", "list", ...cwdArgs, "--json"]).then(parseResult),
          team(["routes", "--json"]).then(parseResult),
          team(["machine", "show", "--json"]).then(parseResult),
        ]);
        if (context !== this.context) return;
        this.routesDoc = routes.status === "fulfilled" ? routes.value : null;
        this.routesError = routes.status === "rejected" ? message(routes.reason) : null;
        this.machineDoc = machine.status === "fulfilled" ? machine.value : null;
        if (list.status === "fulfilled") {
          const { presets, presetsDir, projectRoot, errors, routesReviewed } = list.value;
          this.presetsDir = presetsDir ?? this.presetsDir;
          this.projectRoot = projectRoot ?? null;
          if (presetsDir) this.watchDirectory("presetWatch", presetsDir, cx);
          if (context.cwd && projectRoot) this.watchDirectory("overlayWatch", `${projectRoot.replace(/\/$/, "")}/docs/agent-presets`, cx);
          this.presets = presets;
          this.presetErrors = errors ?? [];
          this.routesReviewed = routesReviewed ?? this.routesDoc?.reviewed;
          this.listError = null;
          const saved = this.presets.find(item => item.id === this.pendingSelection);
          if (saved) this.pendingSelection = null;
          this.selectPreset(saved ?? this.presets.find(item => item.id === this.selectedId)
            ?? sortPresets(this.presets, this.lastUsed)[0]);
        } else {
          this.routesReviewed = this.routesDoc?.reviewed;
          this.listError = message(list.reason);
        }
        context.loading = context.reload;
        cx.notify();
      } while (context.reload);
    });
  }

  selectPreset(item) {
    // A context change can change a preset's defaults even if its id stays the same.
    const preset = item?.preset;
    const signature = JSON.stringify([this.context.key, item?.id, preset?.roles.map(role => [role.id, role.default]), Boolean(preset?.servers?.length)]);
    if (signature !== this.selectionSignature) {
      this.selectionSignature = signature;
      this.selectedId = item?.id;
      this.roles = new Set(preset?.roles.filter(role => role.default !== false).map(role => role.id));
      this.withServers = false;
    }
  }

  edit(preset, isNew, globalSha) {
    openOverlay({
      mod: "hj-team", kind: "dialog", modal: true, width: 640, height: 560,
      props: { dialog: "edit", preset, isNew, globalSha, routes: this.routesDoc?.routes ?? {} },
    });
  }

  editRoutes(space, allPanes, allTerminals) {
    if (checking() || !this.routesDoc) return;
    const { reviewed, routes, routesSha, routesPath, modelsPath, modelsText, modelsSha } = this.routesDoc;
    const doc = { schemaVersion: 1, reviewed, routes };
    const candidates = availableParents(space, allPanes, allTerminals);
    const syncCandidates = candidates.map(terminal => ({
      address: terminal.address,
      label: [terminal.name || terminal.program?.name, terminal.address].filter(Boolean).join(" · "),
    }));
    const syncTarget = pickDefaultParent(space, allPanes, allTerminals, focused());
    openOverlay({
      mod: "hj-team", kind: "dialog", modal: true, width: 720, height: 600,
      props: {
        dialog: "routes", doc, routesSha, routesPath, modelsPath, modelsText, modelsSha,
        machinePath: this.machineDoc?.path ?? null,
        machineSha: this.machineDoc?.sha ?? null,
        machineConfig: this.machineDoc?.config ?? { schemaVersion: 1, executables: {}, path: [], env: {} },
        machineExecutables: this.machineDoc?.executables ?? [],
        presetsDir: this.presetsDir,
        syncCandidates, syncTarget,
      },
    });
  }

  setupMachineWithAgent(cx) {
    if (checking() || this.syncing || this.busy) return;
    const p = props();
    const target = this.syncTarget;
    if (!target) {
      this.error = "현재 스페이스에 요청을 보낼 활성 에이전트가 없습니다.";
      this.syncNotice = null;
      cx.notify();
      return;
    }
    if (!terminals().some(t => t.address === target && t.state === "live")) {
      this.error = `대상 에이전트(${target})가 더 이상 실행 중이 아닙니다.`;
      this.syncNotice = null;
      cx.notify();
      return;
    }
    const label = p.syncCandidates?.find(c => c.address === target)?.label || target;
    const prompt = buildMachineSetupPrompt({ machinePath: p?.machinePath, presetsDir: p?.presetsDir });
    this.syncing = true;
    this.error = null;
    this.syncNotice = null;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await hc(["send", target, prompt]);
        if (result.code !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || "hc send failed");
        this.syncNotice = `${label}에 이 머신 환경 세팅 요청을 보냈습니다.`;
      } catch (error) {
        this.error = message(error);
      } finally {
        this.syncing = false;
        cx.notify();
      }
    });
  }

  syncModels(cx) {
    if (checking() || this.syncing || this.busy) return;
    const p = props();
    const prompt = buildModelSyncPrompt({ request: this.syncInput?.value(), modelsPath: p?.modelsPath, routesPath: p?.routesPath });
    if (!prompt) {
      this.error = "동기화할 모델이나 요청 내용을 입력하세요.";
      this.syncNotice = null;
      cx.notify();
      return;
    }
    const target = this.syncTarget;
    if (!target) {
      this.error = "현재 스페이스에 요청을 보낼 활성 에이전트가 없습니다.";
      this.syncNotice = null;
      cx.notify();
      return;
    }
    if (!terminals().some(t => t.address === target && t.state === "live")) {
      this.error = `대상 에이전트(${target})가 더 이상 실행 중이 아닙니다.`;
      this.syncNotice = null;
      cx.notify();
      return;
    }
    const label = p.syncCandidates?.find(c => c.address === target)?.label || target;
    this.syncing = true;
    this.error = null;
    this.syncNotice = null;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await hc(["send", target, prompt]);
        if (result.code !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || "hc send failed");
        this.syncInput.set_value("");
        this.syncNotice = `${label}에 모델 동기화 요청을 보냈습니다.`;
      } catch (error) {
        this.error = message(error);
      } finally {
        this.syncing = false;
        cx.notify();
      }
    });
  }

  confirm(dialog, id) {
    openOverlay({ mod: "hj-team", kind: "dialog", modal: true, width: 420, height: 248, props: { dialog, id } });
  }

  editWithAgent(item, parent, space, allPanes, allTerminals) {
    const candidates = availableParents(space, allPanes, allTerminals);
    const syncCandidates = candidates.map(terminal => ({
      address: terminal.address,
      label: [terminal.name || terminal.program?.name, terminal.address].filter(Boolean).join(" · "),
    }));
    const syncTarget = parent && candidates.some(t => t.address === parent)
      ? parent : pickDefaultParent(space, allPanes, allTerminals, focused());
    const overlayDir = this.projectRoot ? `${this.projectRoot.replace(/\/+$/, "")}/docs/agent-presets/${item.id}` : null;
    openOverlay({
      mod: "hj-team", kind: "dialog", modal: true, width: 520, height: 256,
      props: {
        dialog: "edit-agent",
        presetId: item.id,
        presetName: item.preset.name,
        presetsDir: this.presetsDir,
        overlayDir,
        syncCandidates,
        syncTarget,
      },
    });
  }

  sendPresetEdit(cx) {
    if (checking() || this.syncing || this.busy) return;
    const p = props();
    const prompt = buildPresetEditPrompt({
      presetId: p?.presetId,
      presetName: p?.presetName,
      presetsDir: p?.presetsDir,
      overlayDir: p?.overlayDir,
      request: this.agentPromptInput?.value(),
    });
    if (!prompt) {
      this.error = "프리셋 수정 요청 내용을 입력하세요.";
      this.syncNotice = null;
      cx.notify();
      return;
    }
    const target = this.syncTarget;
    if (!target) {
      this.error = "현재 스페이스에 요청을 보낼 활성 에이전트가 없습니다.";
      this.syncNotice = null;
      cx.notify();
      return;
    }
    if (!terminals().some(t => t.address === target && t.state === "live")) {
      this.error = `대상 에이전트(${target})가 더 이상 실행 중이 아닙니다.`;
      this.syncNotice = null;
      cx.notify();
      return;
    }
    const label = p.syncCandidates?.find(c => c.address === target)?.label || target;
    this.syncing = true;
    this.error = null;
    this.syncNotice = null;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await hc(["send", target, prompt]);
        if (result.code !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || "hc send failed");
        this.agentPromptInput.set_value("");
        this.syncNotice = `${label}에 프리셋 수정 요청을 보냈습니다.`;
      } catch (error) {
        this.error = message(error);
      } finally {
        this.syncing = false;
        cx.notify();
      }
    });
  }

  applyDialog(cx) {
    if (checking() || this.busy) return;
    const p = props();
    const savingCollected = p?.dialog === "routes" && this.modelsSection === "collected";
    const savingMachine = p?.dialog === "routes" && this.modelsSection === "machine";
    if (!p?.dialog || (p.dialog === "routes" && !savingCollected && !savingMachine && !p.routesSha)) return;
    const editedPreset = p.dialog === "edit" ? normalizePresetFromEdit(this.editor.value(), p.routes ?? {}, this.autoCommands ?? {}) : null;
    const args = p.dialog === "edit" ? ["preset", "save", "--json", editedPreset,
      ...(p.isNew ? [] : ["--update", "--expected-id", this.origId, ...(this.origSha ? ["--expected-sha", this.origSha] : [])])]
      : savingCollected ? ["models", "save", "--text", this.modelsEditor.value(), ...(p.modelsSha ? ["--expected-sha", p.modelsSha] : []), "--json"]
        : savingMachine ? ["machine", "save", "--json", this.machineEditor.value(), ...(p.machineSha ? ["--expected-sha", p.machineSha] : [])]
          : p.dialog === "routes" ? ["routes", "save", "--json", this.editor.value(), "--expected-sha", p.routesSha]
            : p.dialog === "confirm-delete" ? ["preset", "delete", p.id, "--json"] : ["stop", p.id];
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const result = expectSuccess(await team(args, p.dialog === "confirm-stop" ? teamConfig.stopTimeoutMs : teamConfig.presetTimeoutMs));
        if (p.dialog === "edit") setShared(SELECT, JSON.parse(result.stdout).id);
        if (p.dialog !== "confirm-stop") setShared(REVISION, { count: (shared(REVISION)?.count ?? 0) + 1, saved: p.dialog === "edit" });
        closeOverlay(p.overlay);
      } catch (error) {
        this.busy = false;
        this.error = message(error);
        cx.notify();
      }
    });
  }

  seedPresets(cx) {
    if (checking() || this.seeding) return;
    this.seeding = true;
    this.notice = null;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const result = parseResult(await team(["seed", "--json"]));
        this.notice = { lines: [`${result.created.length}개 기본 예시 프리셋을 불러왔습니다.`] };
      } catch (error) {
        this.notice = { error: message(error) };
      } finally {
        this.seeding = false;
        this.refresh(cx);
        cx.notify();
      }
    });
  }

  onboardWithAgent(space, allPanes, allTerminals, cx) {
    if (checking() || this.onboarding) return;
    const target = pickDefaultParent(space, allPanes, allTerminals, focused());
    if (!target) {
      this.notice = { error: "현재 스페이스에 요청을 보낼 활성 에이전트가 없습니다." };
      cx.notify();
      return;
    }
    const prompt = buildOnboardingPrompt({ presetsDir: this.presetsDir, machinePath: this.machineDoc?.path });
    this.onboarding = true;
    this.notice = null;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await hc(["send", target, prompt]);
        if (result.code !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || "hc send failed");
        this.notice = { lines: [`${target}에 내 워크플로우 맞춤 초기 세팅 요청을 보냈습니다.`] };
      } catch (error) {
        this.notice = { error: message(error) };
      } finally {
        this.onboarding = false;
        cx.notify();
      }
    });
  }

  initDocs(item, cx) {
    const context = this.context;
    if (checking() || this.scaffolding || !context.cwd) return;
    this.scaffolding = true;
    this.notice = null;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const result = expectSuccess(await team(["init-project", item.id, "--cwd", context.cwd, "--json"]));
        const { overlayDir } = JSON.parse(result.stdout);
        if (context === this.context) this.notice = { lines: [`docs/ ready · ${overlayDir}`] };
      } catch (error) {
        if (context === this.context) this.notice = { error: message(error) };
      } finally {
        this.scaffolding = false;
        if (context === this.context) this.refresh(cx);
        cx.notify();
      }
    });
  }

  launch(item, parent, cx, { roles: overrideRoles = null, runId = null, withServers = this.withServers } = {}) {
    const context = this.context;
    const selectedRoles = overrideRoles ?? [...this.roles];
    if (checking() || this.launching || !selectedRoles.length || !context.cwd) return;
    if (!runId && parent && !availableParents(spaces().find(s => s.active), panes(), terminals()).some(t => t.address === parent)) {
      this.notice = { error: "That parent is no longer available. Choose a parent and launch again." };
      cx.notify();
      return;
    }
    const args = buildLaunchArgs({
      presetId: item.id, cwd: context.cwd, parent, selectedRoles,
      task: "", withServers: Boolean(withServers && !runId), runId, notifyParent: Boolean(parent || runId),
    });
    this.launching = true;
    this.notice = null;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await team(args, teamConfig.launchTimeoutMs);
        const success = result.code === 0;
        let output;
        try { output = JSON.parse(result.stdout); } catch (e) { if (success) throw e; }
        if (success && !checking()) {
          this.lastUsed = { ...this.lastUsed, [item.id]: Date.now() };
          try { localStorage.setItem(LAST_USED, JSON.stringify(this.lastUsed)); } catch { /* Keep in-memory ordering. */ }
        }
        if (context !== this.context) return;
        const lines = [
          ...(output?.roles ?? []).map(role => `${role.id}: ${role.sent ? "sent" : role.reason || "brief not sent"}`),
          ...(output?.servers ?? []).map(srv => `${srv.id}: ${srv.ready ? "ready" : srv.reason || "not ready"}`),
        ];
        const error = success ? null : output?.roles ? "No roles were launched successfully."
          : formatValidationError(result.stderr, result.stdout);
        this.notice = { title: output?.runId ? `Launch · #${output.runId}` : null, lines, error };
        this.tab = success ? "runs" : "presets";
      } catch (error) {
        if (context === this.context) this.notice = { error: message(error) };
      } finally {
        this.launching = false;
        cx.notify();
      }
    });
  }

  dialog(t, p) {
    if (p.dialog === "edit-agent") {
      const candidates = p.syncCandidates ?? [];
      const targetLabel = candidates.find(c => c.address === this.syncTarget)?.label || "활성 에이전트 없음";
      return v_flex().size_full().min_h(0).p(16).gap(10).bg(t.popover).text_color(t.foreground).text_size(13)
        .child(h_flex().gap(8).items_center().flex_none()
          .child(div().text_size(15).font_semibold().truncate().child(`Edit preset · ${p.presetName || p.presetId}`))
          .child(div().flex_1())
          .child(action(t, "edit-agent-target", `${targetLabel}${candidates.length > 1 ? " ↻" : ""}`, (_e, cx) => {
            if (candidates.length < 2) return;
            const i = candidates.findIndex(c => c.address === this.syncTarget);
            this.syncTarget = candidates[(i + 1) % candidates.length].address;
            cx.notify();
          }, { disabled: candidates.length <= 1 })))
        .child(div().text_size(11.5).line_height("16px").text_color(t.dim)
          .child("선택한 에이전트에게 이 프리셋 수정을 요청합니다. 프로젝트 전용 규칙은 오버레이(docs/agent-presets/)로 분리됩니다."))
        .child(Input.new(this.agentPromptInput).h(32).w_full().px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_color(t.foreground))
        .when(Boolean(this.syncNotice), el => el.child(div().text_size(11.5).text_color(t.ansi2).child(this.syncNotice)))
        .when(Boolean(this.error), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
        .child(div().flex_1())
        .child(h_flex().gap(8).justify_end().flex_none()
          .child(action(t, "cancel", "Close", () => closeOverlay(p.overlay), { disabled: Boolean(this.syncing) }))
          .child(action(t, "send-edit-agent", this.syncing ? "Sending…" : "Send", (_e, cx) => this.sendPresetEdit(cx),
            { primary: true, disabled: Boolean(this.syncing || !this.syncTarget) })));
    }
    const edit = p.dialog === "edit", routes = p.dialog === "routes", stop = p.dialog === "confirm-stop";
    const editing = edit || routes;
    const collected = routes && this.modelsSection === "collected";
    const machine = routes && this.modelsSection === "machine";
    const title = routes ? "Models" : edit ? p.isNew ? "New preset" : "Edit preset JSON" : stop ? `Stop run #${p.id}?` : `Delete ${p.id}?`;
    const detail = collected
      ? "수집된 모델 프로파일(_models.md). 아래 입력으로 포커스된 에이전트에게 새 모델 조사·동기화를 바로 요청할 수 있습니다."
      : machine ? `이 컴퓨터 전용 로컬 설정(${p.machinePath || "~/.config/hc-team/machine.json"}). 에이전트 실행 경로·환경을 머신별로 분리합니다.`
        : routes ? "프리셋 역할들이 공통으로 참조하는 에이전트별 모델 라우팅(_routes.json)."
          : edit ? "전역 프리셋 JSON입니다. 각 role의 command를 수정하면 해당 역할만의 모델로 저장되고, 그대로 두거나 지우면 route의 공통 모델을 따릅니다."
            : stop ? "This ends all live role and server terminals in this run, including any still working."
              : "This removes the global preset. Project docs and running sessions are not removed.";
    const label = editing ? "Save" : stop ? "Stop run" : "Delete preset";
    const candidates = p.syncCandidates ?? [];
    const targetLabel = candidates.find(c => c.address === this.syncTarget)?.label || "활성 에이전트 없음";
    const sectionTab = (id, text) => action(t, `models-sec-${id}`, text, (_e, cx) => {
      this.modelsSection = id;
      this.error = null;
      this.syncNotice = null;
      cx.notify();
    }, { selected: this.modelsSection === id });
    return v_flex().size_full().min_h(0).p(16).gap(10).bg(t.popover).text_color(t.foreground).text_size(13)
      .child(h_flex().gap(8).items_center().flex_none()
        .child(div().text_size(16).font_semibold().child(title))
        .when(routes, el => el.child(h_flex().gap(4).p(2).rounded(8).bg(t.chrome)
          .child(sectionTab("routes", "공통 역할 모델"))
          .child(sectionTab("collected", "수집된 모델"))
          .child(sectionTab("machine", "이 머신"))))
        .child(div().flex_1())
        .when(routes && !machine && Boolean(p.doc.reviewed), el => el.child(div().text_size(10.5).text_color(t.dim).child(p.doc.reviewed))))
      .child(div().text_size(11.5).line_height("16px").text_color(t.dim).child(detail))
      .when(edit && Object.keys(p.routes ?? {}).length > 0, el => el.child(chips().items_center().flex_none()
        .child(div().text_size(10.5).text_color(t.dim).child("routes:"))
        .children(Object.keys(p.routes).sort().map(name => badge(t, name)))))
      .when(routes && !collected && !machine && !p.routesSha, el => el.child(meta(t, "Run hc-team seed to create _routes.json, then reopen Models.")))
      .when(collected, el => el.child(card(t).p(10).gap(6).flex_none()
        .child(h_flex().gap(8).items_center().min_w(0)
          .child(caption(t, "에이전트 모델 Sync"))
          .child(div().flex_1())
          .child(action(t, "sync-target", `${targetLabel}${candidates.length > 1 ? " ↻" : ""}`, (_e, cx) => {
            if (candidates.length < 2) return;
            const i = candidates.findIndex(c => c.address === this.syncTarget);
            this.syncTarget = candidates[(i + 1) % candidates.length].address;
            cx.notify();
          }, { disabled: candidates.length <= 1 })))
        .child(h_flex().gap(6).items_center()
          .child(Input.new(this.syncInput).flex_1().h(30).px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_color(t.foreground))
          .child(action(t, "sync-send", this.syncing ? "Sending…" : "Sync", (_e, cx) => this.syncModels(cx),
            { primary: true, disabled: Boolean(this.syncing || !this.syncTarget) })))
        .when(Boolean(this.syncNotice), box => box.child(div().text_size(11.5).text_color(t.ansi2).child(this.syncNotice)))))
      .when(machine, el => el.child(card(t).p(10).gap(6).flex_none()
        .child(h_flex().gap(8).items_center().min_w(0)
          .child(caption(t, "에이전트 머신 세팅"))
          .child(div().flex_1())
          .child(action(t, "machine-target", `${targetLabel}${candidates.length > 1 ? " ↻" : ""}`, (_e, cx) => {
            if (candidates.length < 2) return;
            const i = candidates.findIndex(c => c.address === this.syncTarget);
            this.syncTarget = candidates[(i + 1) % candidates.length].address;
            cx.notify();
          }, { disabled: candidates.length <= 1 }))
          .child(action(t, "machine-setup", this.syncing ? "Sending…" : "에이전트로 세팅", (_e, cx) => this.setupMachineWithAgent(cx),
            { primary: true, disabled: Boolean(this.syncing || !this.syncTarget) })))
        .when(Boolean(p.machineExecutables?.length), box => box.child(chips().children(p.machineExecutables.map(row =>
          badge(t, `${row.name}: ${row.ok ? row.source : "missing"}`, row.ok ? t.ansi2 : t.ansi1)))))
        .when(Boolean(this.syncNotice), box => box.child(div().text_size(11.5).text_color(t.ansi2).child(this.syncNotice)))))
      .when(editing && !collected && !machine, el => el.child(Editor.new(this.editor).flex_1().min_h(0).border_1().border_color(t.input).rounded(6)))
      .when(collected, el => el.child(Editor.new(this.modelsEditor).flex_1().min_h(0).border_1().border_color(t.input).rounded(6)))
      .when(machine, el => el.child(Editor.new(this.machineEditor).flex_1().min_h(0).border_1().border_color(t.input).rounded(6)))
      .when(!editing, el => el.child(div().flex_1()))
      .when(Boolean(this.error), el => el.child(v_flex().id("dialog-errors").max_h(96).overflow_y_scrollbar().gap(4)
        .children(this.error.split("\n").map(line => div().text_size(12).text_color(t.ansi1).child(line)))))
      .child(h_flex().gap(8).justify_end().flex_none()
        .child(action(t, "cancel", "Cancel", () => closeOverlay(p.overlay), { disabled: Boolean(this.busy || this.syncing) }))
        .child(action(t, "apply", this.busy ? "Working…" : label, (_e, cx) => this.applyDialog(cx),
          { primary: editing, danger: !editing, disabled: Boolean(this.busy || this.syncing || (routes && !collected && !machine && !p.routesSha)) })));
  }

  launchBar(t, item, space, allPanes, allTerminals) {
    const candidates = availableParents(space, allPanes, allTerminals);
    const parents = [...candidates.map(terminal => terminal.address), null];
    const parent = this.parentOverride === undefined ? pickDefaultParent(space, allPanes, allTerminals, focused())
      : parents.includes(this.parentOverride) ? this.parentOverride : null;
    const chosen = candidates.find(terminal => terminal.address === parent);
    const parentName = chosen?.name || chosen?.program?.name;
    const preset = item.preset;
    const canLaunch = this.roles.size > 0 && Boolean(this.context.cwd) && !this.launching;
    return card(t)
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(caption(t, "Parent").flex_none())
        .child(action(t, "parent", `${parent ? [parentName, parent].filter(Boolean).join(" · ") : "None (no parent)"}${parents.length > 1 ? " ↻" : ""}`, (_e, cx) => {
          this.parentOverride = parents[(parents.indexOf(parent) + 1) % parents.length];
          cx.notify();
        }, { disabled: parents.length === 1 })))
      .child(caption(t, "Roles to launch"))
      .child(chips().children(preset.roles.map(role => action(t, `role-select-${role.id}`, `${this.roles.has(role.id) ? "✓ " : "+ "}${role.id}`, (_e, cx) => {
        if (this.roles.has(role.id)) this.roles.delete(role.id); else this.roles.add(role.id);
        cx.notify();
      }, { selected: this.roles.has(role.id) }))))
      .child(h_flex().gap(8).items_center()
        .child(action(t, "edit-with-agent", "Edit w/ Agent", () => this.editWithAgent(item, parent, space, allPanes, allTerminals),
          { disabled: !candidates.length }))
        .when(Boolean(preset.servers?.length), el => el.child(action(t, "servers", this.withServers ? "✓ Servers" : "+ Servers", (_e, cx) => {
          this.withServers = !this.withServers;
          cx.notify();
        }, { selected: this.withServers })))
        .child(div().flex_1())
        .child(action(t, "launch", this.launching ? "Launching…" : "Launch", (_e, cx) => this.launch(item, parent, cx), { primary: true, disabled: !canLaunch })))
      .when(!this.context.cwd, el => el.child(meta(t, "Launch and project docs require a local project folder.")));
  }

  renderPresets(t, space, allPanes, allTerminals) {
    const entries = sortPresets(this.presets, this.lastUsed);
    const item = entries.find(preset => preset.id === this.selectedId);
    const root = v_flex().flex_1().min_h(0);
    if (this.listError) root.child(div().flex_none().px(12).pt(8).text_size(12).text_color(t.ansi1).child(this.listError));
    if (this.routesError) root.child(meta(t, `Models unavailable · ${this.routesError}`).flex_none().px(12).pt(6));
    if (this.presetErrors.length) root.child(card(t).flex_none().mx(12).mt(8).p(8).gap(4)
      .child(caption(t, `${this.presetErrors.length} preset ${this.presetErrors.length === 1 ? "warning" : "warnings"}`).text_color(t.ansi3))
      .child(v_flex().id("preset-warnings").max_h(72).overflow_y_scrollbar().gap(4)
        .children(this.presetErrors.map(({ id, path, message }) => meta(t, `${id || path || "Preset"}: ${message}`)))));
    if (!this.presets.length) {
      if (this.context.loading || this.listError) {
        return root.child(panelBody("teams-presets").child(meta(t, this.context.loading ? "Loading presets…" : "Could not load presets.")));
      }
      const hasAgent = Boolean(pickDefaultParent(space, allPanes, allTerminals, focused()));
      return root.child(panelBody("teams-presets").child(card(t).gap(8)
        .child(div().text_size(14).font_semibold().child("내 팀 프리셋 시작하기"))
        .child(div().text_size(11.5).line_height("16px").text_color(t.dim)
          .child(`${this.presetsDir || "~/.herdr/hj-team"} 에 아직 프리셋이 없습니다. 설치된 에이전트와 워크플로우에 맞게 세팅하거나 기본 예시를 불러올 수 있습니다.`))
        .child(h_flex().gap(8).flex_wrap()
          .child(action(t, "onboard-agent", this.onboarding ? "Sending…" : "에이전트로 초기 세팅",
            (_e, cx) => this.onboardWithAgent(space, allPanes, allTerminals, cx),
            { primary: true, disabled: Boolean(this.onboarding || !hasAgent) }))
          .child(action(t, "seed-examples", this.seeding ? "Loading…" : "기본 예시 불러오기",
            (_e, cx) => this.seedPresets(cx), { disabled: Boolean(this.seeding) })))));
    }
    const listHeight = Math.min(entries.length * 48 + 24, teamConfig.visiblePresetRows * 48 + 24);
    // overflow_y_scrollbar() wraps the list and breaks absolute inset sizing; pair overflow_y_scroll() with Scrollbar.vertical.
    root.child(div().h(listHeight).flex_none().relative().border_b(1).border_color(t.border)
      .child(v_flex().id("preset-list").absolute().inset_0().overflow_y_scroll()
        .child(v_flex().flex_none().w_full().min_w(0).px(12).py(12)
          .children(entries.map(entry => {
            const selected = entry === item;
            return h_flex().id(`preset-${entry.id}`).h(48).flex_none().w_full().min_w(0).px(8).rounded(6)
              .items_center().bg(selected ? t.selected : t.background)
              .cursor_pointer().hover(s => s.bg(selected ? t.selected : t.hover))
              .on_click((_e, cx) => {
                this.pendingSelection = null;
                this.selectPreset(entry);
                this.notice = null;
                cx.notify();
              })
              .child(v_flex().flex_1().min_w(0).gap(6)
                .child(h_flex().gap(6).min_w(0).items_center()
                  .child(div().min_w(0).truncate().when(selected, el => el.font_semibold()).child(entry.name))
                  .child(badge(t, `${entry.roleCount} ${entry.roleCount === 1 ? "role" : "roles"}`))
                  .when(entry.hasOverlay, el => el.child(badge(t, "docs/", t.ansi2))))
                .child(div().text_size(10.5).text_color(t.dim).min_w(0).truncate().child(entry.description || "No description")));
          }))))
      .child(Scrollbar.vertical("preset-list").mode("always").absolute().inset_0()));
    const body = panelBody("teams-presets");
    if (!item) return root.child(body.child(meta(t, "Select a preset to see its roles.")));
    const preset = item.preset;
    const roles = preset.roles.map(role => ({ role, harness: describeRoleCommand(role.command, role.routeError) }));
    const harnesses = new Map();
    for (const { harness } of roles) {
      const count = (harnesses.get(harness.name)?.count ?? 0) + 1;
      harnesses.set(harness.name, { harness, count });
    }
    const selectedParent = (() => {
      const candidates = availableParents(space, allPanes, allTerminals);
      const parents = [...candidates.map(terminal => terminal.address), null];
      return this.parentOverride === undefined ? pickDefaultParent(space, allPanes, allTerminals, focused())
        : parents.includes(this.parentOverride) ? this.parentOverride : null;
    })();
    const initDisabled = !this.context.cwd || Boolean(this.scaffolding);
    const soloDisabled = !this.context.cwd || Boolean(this.launching);
    return root.child(body
      .child(v_flex().gap(8)
        .child(v_flex().gap(6)
          .child(h_flex().gap(8).items_center().min_w(0)
            .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(preset.name))
            .when(item.hasOverlay, el => el.child(div().flex_none().rounded(5).px(5).py(1).bg(t.selected).text_size(10).text_color(t.ansi2).child("docs/")))
            .when(!item.hasOverlay, el => el.child(Button.new("init-docs").flex().flex_none().h(20).px(6).items_center().rounded(5)
              .border_1().border_color(t.border).bg(t.background).text_size(10).text_color(t.dim).disabled(initDisabled)
              .when(!initDisabled, btn => btn.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.muted)).on_click((_e, cx) => this.initDocs(item, cx)))
              .child(this.scaffolding ? "Creating…" : "Init docs/"))))
          .when(Boolean(preset.description), el => el.child(div().text_size(11).line_height("15px").text_color(t.dim).child(preset.description))))
        .child(chips().children([...harnesses.values()].map(({ harness, count }) => harnessBadge(t, harness, count)))))
      .child(this.launchBar(t, item, space, allPanes, allTerminals))
      .child(v_flex().gap(4).child(caption(t, "Role preview"))
        .children(roles.map(({ role, harness }) => v_flex().gap(4).py(8).border_b(1).border_color(t.border)
          .child(h_flex().gap(6).items_center().min_w(0)
            .child(div().font_semibold().child(role.id))
            .child(meta(t, role.title).flex_1().min_w(0).truncate())
            .when(role.readOnly, el => el.child(badge(t, "Read only")))
            .child(Button.new(`run-solo-${role.id}`).flex().flex_none().h(20).px(6).items_center().rounded(5)
              .border_1().border_color(t.border).bg(t.background).text_size(10).text_color(t.dim).disabled(soloDisabled)
              .when(!soloDisabled, btn => btn.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => this.launch(item, selectedParent, cx, { roles: [role.id], withServers: false })))
              .child("Run")))
          .child(chips().items_center().min_w(0)
            .when(Boolean(role.route), el => el.child(badge(t, role.route)))
            .when(!harness.error, el => el.child(harnessBadge(t, harness)))
            .when(Boolean(harness.model), el => el.child(badge(t, harness.model).max_w(260).truncate())))
          .when(Boolean(harness.error), el => el.child(meta(t, harness.error).text_color(t.ansi1)))
          .when(Boolean(harness.executable), el => el.child(meta(t, harness.executable).truncate()))
          .when(Boolean(role.skills?.length), el => el.child(chips().children(role.skills.map(skill => badge(t, skill)))))
          .when(Boolean(role.tools?.length), el => el.child(meta(t, `Tools: ${role.tools.join(" · ")}`).truncate()))
          .when(Boolean(role.talksTo?.length), el => el.child(meta(t, `Talks to: ${role.talksTo.join(", ")}`))))))
      .child(h_flex().justify_between().gap(8)
        .child(action(t, "edit-preset", "Edit JSON", () => this.edit(item.globalPreset, false, item.globalSha)))
        .child(action(t, "delete-preset", "Delete", () => this.confirm("confirm-delete", item.id), { danger: true }))));
  }

  renderRuns(t, runs, space, allPanes, allTerminals) {
    const row = (entry, server) => Button.new(`run-terminal-${entry.address}`).flex().w_full().min_w(0).rounded(6).px(4).py(4)
      .cursor_pointer().hover(s => s.bg(t.hover)).focus(s => s.bg(t.selected)).on_click(() => {
        if (checking()) return;
        const command = panes().some(pane => pane.terminal === entry.address) ? "pane.focus" : "terminal.peek";
        run(command, { terminal: entry.address });
      }).child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(8).items_center().min_w(0)
          .child(statusMark(t, entry.status))
          .child(div().flex_1().min_w(0).truncate().child(entry.id))
          .when(server, el => el.child(badge(t, "server")))
          .child(meta(t, entry.address).truncate()))
        .when(Boolean(entry.last), el => el.child(meta(t, `${entry.last.kind} → ${entry.last.to}: ${entry.last.summary}`).pl(22).truncate())));
    const entries = sortPresets(this.presets, this.lastUsed);
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const soloPreset = entries.find(entry => entry.id === (this.soloPresetId ?? this.selectedId)) ?? entries[0] ?? null;
    const candidates = availableParents(space, allPanes, allTerminals);
    const parents = [...candidates.map(terminal => terminal.address), null];
    const parent = this.parentOverride === undefined ? pickDefaultParent(space, allPanes, allTerminals, focused())
      : parents.includes(this.parentOverride) ? this.parentOverride : null;
    const chosen = candidates.find(terminal => terminal.address === parent);
    const parentLabel = parent ? [chosen?.name || chosen?.program?.name, parent].filter(Boolean).join(" · ") : "None";
    const canSummon = Boolean(this.context?.cwd) && !this.launching;
    return panelBody("teams-runs")
      .when(!runs.length, el => el.child(meta(t, "No live team runs.")))
      .children(runs.map(group => {
        const presetItem = group.presetId ? byId.get(group.presetId) : null;
        const liveIds = new Set(group.roles.map(r => r.id));
        const extraRoles = (presetItem?.preset?.roles ?? []).filter(role => !liveIds.has(role.id));
        return card(t)
          .child(h_flex().gap(8).items_center()
            .child(div().flex_1().min_w(0).truncate().font_semibold().child(`${group.presetId ?? "Team"} · #${group.runId}`))
            .child(action(t, `stop-${group.runId}`, "Stop", () => this.confirm("confirm-stop", group.runId), { danger: true })))
          .children(group.roles.map(role => row(role, false)))
          .children(group.servers.map(server => row(server, true)))
          .when(Boolean(presetItem && extraRoles.length), el => el.child(h_flex().gap(4).flex_wrap().items_center().pt(4).border_t(1).border_color(t.border)
            .child(div().text_size(10.5).text_color(t.dim).child("Add:"))
            .children(extraRoles.map(role => action(t, `add-role-${group.runId}-${role.id}`, `+ ${role.id}`,
              (_e, cx) => this.launch(presetItem, null, cx, { roles: [role.id], runId: group.runId, withServers: false }),
              { disabled: !canSummon })))));
      }))
      .when(Boolean(soloPreset), el => el.child(card(t).gap(6)
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(caption(t, "단일 팀원 실행").flex_none())
          .child(div().flex_1())
          .child(action(t, "solo-parent", `${parentLabel}${parents.length > 1 ? " ↻" : ""}`, (_e, cx) => {
            this.parentOverride = parents[(parents.indexOf(parent) + 1) % parents.length];
            cx.notify();
          }, { disabled: parents.length <= 1 })))
        .child(action(t, "solo-preset", `${soloPreset.name}${entries.length > 1 ? " ↻" : ""}`, (_e, cx) => {
          const i = entries.findIndex(entry => entry.id === soloPreset.id);
          this.soloPresetId = entries[(i + 1) % entries.length].id;
          cx.notify();
        }, { disabled: entries.length <= 1 }))
        .child(chips().children(soloPreset.preset.roles.map(role =>
          action(t, `summon-role-${soloPreset.id}-${role.id}`, `+ ${role.id}`,
            (_e, cx) => this.launch(soloPreset, parent, cx, { roles: [role.id], withServers: false }),
            { disabled: !canSummon }))))));
  }

  render(cx) {
    const t = theme(), p = props();
    if (p?.dialog) return this.dialog(t, p);
    this.wakeWatches(cx);
    const space = spaces().find(s => s.active), allPanes = panes(), allTerminals = terminals();
    this.syncPresets(space, allPanes, cx);
    const runs = groupRuns(allTerminals), notice = this.notice;
    const tab = (id, label) => action(t, `teams-tab-${id}`, label, (_e, cx) => { this.tab = id; cx.notify(); }, { selected: this.tab === id });
    return v_flex().size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().flex_none().p(8).gap(8).items_center().border_b(1).border_color(t.border)
        .child(h_flex().gap(4).items_center().p(2).rounded(8).bg(t.chrome)
          .child(tab("presets", "Presets"))
          .child(tab("runs", h_flex().gap(4).items_center().child("Runs").child(badge(t, String(runs.length))))))
        .child(div().flex_1())
        .child(action(t, "models", h_flex().gap(4).items_center()
          .child("Models")
          .when(Boolean(this.routesReviewed), el => el.child(div().text_size(9.5).text_color(t.dim).child(this.routesReviewed.replace(/^\d{4}-/, "")))),
        () => this.editRoutes(space, allPanes, allTerminals), { disabled: !this.routesDoc }))
        .child(action(t, "new-preset", "+ New", () => this.edit(newPresetSkeleton(), true))))
      .when(Boolean(notice), el => el.child(v_flex().id("teams-notice").flex_none().max_h(144).overflow_y_scrollbar().mx(12).mt(8).p(8).gap(4).rounded(6).bg(t.raised)
        .when(Boolean(notice.title), card => card.child(caption(t, notice.title)))
        .children((notice.lines ?? []).map(line => meta(t, line)))
        .when(Boolean(notice.error), card => card.child(div().text_size(12).text_color(t.ansi1).child(notice.error)))))
      .child(this.tab === "runs" ? this.renderRuns(t, runs, space, allPanes, allTerminals) : this.renderPresets(t, space, allPanes, allTerminals));
  }
}
