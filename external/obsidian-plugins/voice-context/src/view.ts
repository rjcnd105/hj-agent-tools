import { ItemView, Notice, type TFile, type WorkspaceLeaf, debounce, setIcon } from "obsidian";
import type VoiceContextPlugin from "./main";
import { formatClock } from "./markdown";
import { listSessions } from "./session";

export const VIEW_TYPE = "voice-context-recorder";

const LIVE_TAIL_CHARS = 2000;
const RECENT_SESSIONS = 8;
const STATUS_LABEL = { idle: "대기", recording: "녹음 중", paused: "일시정지" } as const;

/** Sidebar panel: recording stays visible and controllable while the editor keeps working. */
export class RecorderView extends ItemView {
	private statusEl!: HTMLElement;
	private timerEl!: HTMLElement;
	private startBtn!: HTMLButtonElement;
	private importBtn!: HTMLButtonElement;
	private insertBtn!: HTMLButtonElement;
	private pauseBtn!: HTMLButtonElement;
	private stopBtn!: HTMLButtonElement;
	private cancelBtn!: HTMLButtonElement;
	private presetRow!: HTMLElement;
	private presetSelect!: HTMLSelectElement;
	private liveEl!: HTMLElement;
	private pendingEl!: HTMLElement;
	private contextInput!: HTMLTextAreaElement;
	private contextBtns: HTMLButtonElement[] = [];
	private contextList!: HTMLElement;
	private sessionList!: HTMLElement;
	private readonly refreshSessions = debounce(() => this.renderSessions(), 500, true);

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: VoiceContextPlugin,
	) {
		super(leaf);
	}

	override getViewType() {
		return VIEW_TYPE;
	}

	override getDisplayText() {
		return "Voice Context";
	}

	override getIcon() {
		return "mic";
	}

	private get controller() {
		return this.plugin.controller;
	}

	override async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("voice-context-view");

		const head = root.createDiv("vc-head");
		this.statusEl = head.createSpan("vc-status");
		this.timerEl = head.createSpan("vc-timer");

		const controls = root.createDiv("vc-controls");
		this.startBtn = this.button(controls, "mic", "새 녹음", () => void this.plugin.startRecording(), "mod-cta");
		this.importBtn = this.button(controls, "file-audio", "가져오기", () => this.plugin.pickImport());
		this.insertBtn = this.button(controls, "file-input", "현재 노트에 넣기", () => this.plugin.pickInsert());
		this.pauseBtn = this.button(controls, "pause", "일시정지", () => this.controller.togglePause());
		this.stopBtn = this.button(controls, "square", "정지 후 정리", () => void this.controller.stop(), "mod-warning");
		this.cancelBtn = this.button(controls, "x", "취소", () => this.controller.cancel());

		this.presetRow = root.createEl("label", "vc-preset-pick");
		this.presetRow.createSpan({ text: "프리셋" });
		this.presetSelect = this.presetRow.createEl("select", { cls: "dropdown", attr: { "aria-label": "새 녹음에 쓸 프리셋" } });
		this.presetSelect.addEventListener("change", () => {
			this.plugin.settings.activePreset = this.presetSelect.value;
			void this.plugin.saveSettings();
			this.plugin.settingTab.update();
		});

		root.createDiv({ cls: "vc-label", text: "받아쓰기" });
		this.liveEl = root.createDiv("vc-live");
		this.pendingEl = root.createDiv("vc-pending");

		root.createDiv({ cls: "vc-label", text: "Context" });
		this.contextInput = root.createEl("textarea", {
			cls: "vc-context-input",
			attr: { rows: "3", placeholder: "메모, 지시, 링크를 적고 Mod+Enter로 추가" },
		});
		this.contextInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				void this.submitContext();
			}
		});
		const contextControls = root.createDiv("vc-context-controls");
		this.contextBtns = [
			this.button(contextControls, "text-select", "선택 영역 추가", () => this.addSelection()),
			this.button(contextControls, "plus", "추가", () => void this.submitContext()),
		];
		this.contextList = root.createEl("ul", "vc-context-list");

		root.createDiv({ cls: "vc-label", text: "최근 세션" });
		this.sessionList = root.createDiv("vc-sessions");

		this.register(this.controller.onChange(() => this.render()));
		const inFolder = (file: { path: string }) => file.path.startsWith(`${this.plugin.settings.recordingsFolder}/`);
		this.registerEvent(this.app.metadataCache.on("changed", (file) => inFolder(file) && this.refreshSessions()));
		this.registerEvent(this.app.vault.on("delete", (file) => inFolder(file) && this.refreshSessions()));
		this.registerEvent(this.app.vault.on("rename", (file, old) => (inFolder(file) || inFolder({ path: old })) && this.refreshSessions()));
		this.render();
		this.renderSessions();
	}

	override async onClose() {
		this.refreshSessions.cancel();
	}

	tick() {
		this.timerEl.setText(this.controller.run ? formatClock(this.controller.elapsedMs) : "");
	}

	private button(parent: HTMLElement, icon: string, label: string, onClick: () => void, cls?: string) {
		const btn = parent.createEl("button", { cls, attr: { "aria-label": label } });
		setIcon(btn.createSpan("vc-btn-icon"), icon);
		btn.createSpan({ text: label });
		btn.addEventListener("click", onClick);
		return btn;
	}

	private render() {
		const { status, run, stage } = this.controller;
		this.statusEl.setText(status === "processing" ? stage : STATUS_LABEL[status]);
		this.statusEl.dataset.status = status;
		this.tick();

		const active = status === "recording" || status === "paused";
		this.startBtn.toggle(status === "idle");
		this.importBtn.toggle(status === "idle");
		this.insertBtn.toggle(status === "idle");
		this.pauseBtn.toggle(active);
		this.stopBtn.toggle(active);
		this.cancelBtn.toggle(status === "processing");
		this.renderPresets();
		const pauseLabel = status === "paused" ? "재개" : "일시정지";
		this.pauseBtn.setAttr("aria-label", pauseLabel);
		this.pauseBtn.lastElementChild?.setText(pauseLabel);
		setIcon(this.pauseBtn.firstElementChild as HTMLElement, status === "paused" ? "play" : "pause");

		const live = run?.texts.join("\n\n") ?? "";
		this.liveEl.setText(live.length > LIVE_TAIL_CHARS ? `…${live.slice(-LIVE_TAIL_CHARS)}` : live);
		this.liveEl.toggleClass("is-empty", !live);
		if (!live) this.liveEl.setText(run ? "첫 녹음 조각이 끝나면 받아쓴 글이 표시됩니다." : status === "processing" ? stage : "녹음을 시작하면 받아쓴 글이 여기에 표시됩니다.");
		this.liveEl.scrollTop = this.liveEl.scrollHeight;
		const notes = [run?.pendingSegments ? `받아쓰는 중 ${run.pendingSegments}개` : "", run?.failed ? `실패 ${run.failed}개` : ""].filter(Boolean);
		this.pendingEl.setText(notes.join(" · "));

		this.contextInput.disabled = !active;
		for (const btn of this.contextBtns) btn.disabled = !active;
		this.contextList.empty();
		for (const title of run?.contexts ?? []) this.contextList.createEl("li", { text: title });

		for (const btn of Array.from(this.sessionList.querySelectorAll("button"))) btn.disabled = status !== "idle";
	}

	/** Phrase hints apply per segment, so the choice is offered only before a recording starts. */
	renderPresets() {
		const { settings } = this.plugin;
		this.presetSelect.empty();
		for (const name of ["", ...settings.phrasePresets.map((p) => p.name)]) this.presetSelect.createEl("option", { value: name, text: name || "없음" });
		this.presetSelect.value = settings.phrasePresets.some((p) => p.name === settings.activePreset) ? settings.activePreset : "";
		this.presetRow.toggle(settings.transcriptionProvider === "azure" && settings.phrasePresets.length > 0 && this.controller.status === "idle");
	}

	renderSessions() {
		this.sessionList.empty();
		const sessions = listSessions(this.app, this.plugin.settings.recordingsFolder).slice(0, RECENT_SESSIONS);
		if (!sessions.length) {
			this.sessionList.createDiv({ cls: "vc-empty", text: "아직 세션이 없습니다." });
			return;
		}
		for (const session of sessions) this.renderSession(session);
	}

	private renderSession(session: TFile) {
		const row = this.sessionList.createDiv("vc-session");
		const link = row.createEl("a", { cls: "vc-session-name", text: session.basename, href: "#" });
		link.addEventListener("click", (e) => {
			e.preventDefault();
			void this.app.workspace.openLinkText(session.path, "", false);
		});
		const btn = this.button(row, "redo", "이어 녹음", () => void this.plugin.startRecording(session));
		btn.disabled = this.controller.status !== "idle";
	}

	private async submitContext() {
		const text = this.contextInput.value.trim();
		if (!text) return;
		if (await this.controller.addContext("메모", text)) this.contextInput.value = "";
	}

	private addSelection() {
		const view = this.controller.workingView();
		if (!view?.editor.somethingSelected()) return void new Notice("노트에서 추가할 내용을 먼저 선택하세요.");
		this.controller.addSelection(view.editor, view.file);
	}
}
