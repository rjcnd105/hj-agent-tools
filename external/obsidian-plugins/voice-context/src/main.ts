import { Notice, Platform, Plugin, type TFile } from "obsidian";
import { ChatGPTAuth } from "./chatgpt";
import { RecordingController } from "./controller";
import { formatClock } from "./markdown";
import { FilePicker } from "./modals";
import { listModels } from "./openai";
import { registerSegmentActions } from "./segment-actions";
import { listImportable, listSessions } from "./session";
import { DEFAULT_AZURE_SECRET_ID, DEFAULT_SECRET_ID, DEFAULT_SETTINGS, type VoiceContextSettings, VoiceContextSettingTab } from "./settings";
import { RecorderView, VIEW_TYPE } from "./view";

type ModelKind = "summary" | "transcription";

const NOT_CHAT_MODEL = /audio|tts|realtime|image|embedding|search|moderation|transcribe|live/;

export default class VoiceContextPlugin extends Plugin {
	declare settings: VoiceContextSettings;
	chatgpt!: ChatGPTAuth;
	controller!: RecordingController;
	settingTab!: VoiceContextSettingTab;
	private statusEl!: HTMLElement;
	private timer = 0;
	private readonly modelCache = new Map<ModelKind, Promise<string[]>>();

	override async onload() {
		await this.loadSettings();
		this.chatgpt = new ChatGPTAuth(this);
		this.controller = new RecordingController(this);

		this.registerView(VIEW_TYPE, (leaf) => new RecorderView(leaf, this));
		this.addRibbonIcon("mic", "Voice Context: 녹음 시작/정지", () => {
			if (this.controller.status === "idle") void this.startRecording();
			else if (this.controller.status !== "processing") void this.controller.stop();
			else void this.revealView();
		});
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("voice-context-status", "mod-clickable");
		this.statusEl.addEventListener("click", () => void this.revealView());
		this.register(this.controller.onChange(() => this.onStatusChange()));
		this.onStatusChange();
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "visible") void this.controller.wakeLock.reacquire();
		});

		this.addCommand({ id: "start-recording", name: "새 녹음 시작", icon: "mic", checkCallback: (checking) => this.idle(checking, () => this.startRecording()) });
		this.addCommand({
			id: "continue-recording",
			name: "이어 녹음…",
			icon: "redo",
			checkCallback: (checking) => this.idle(checking, () => this.pickSession("이어 녹음할 세션", (s) => void this.startRecording(s))),
		});
		this.addCommand({
			id: "import-existing",
			name: "기존 녹음 가져오기…",
			icon: "file-audio",
			checkCallback: (checking) => this.idle(checking, () => this.pickImport()),
		});
		this.addCommand({
			id: "toggle-pause",
			name: "일시정지/재개",
			icon: "pause",
			checkCallback: (checking) => this.recording(checking, () => this.controller.togglePause()),
		});
		this.addCommand({
			id: "stop-recording",
			name: "녹음 정지 후 정리",
			icon: "square",
			checkCallback: (checking) => this.recording(checking, () => void this.controller.stop()),
		});
		this.addCommand({
			id: "add-selection-context",
			name: "선택 영역을 context에 추가",
			icon: "text-select",
			editorCheckCallback: (checking, editor, ctx) => {
				if (!this.controller.run || this.controller.status === "processing" || !editor.somethingSelected()) return false;
				if (!checking) this.controller.addSelection(editor, ctx.file);
				return true;
			},
		});
		this.addCommand({
			id: "rewrite-summary",
			name: "정리 다시 쓰기",
			icon: "refresh-cw",
			checkCallback: (checking) => this.idle(checking, () => this.withSession("다시 정리할 세션", (s) => void this.controller.rewrite(s))),
		});
		this.addCommand({
			id: "retry-failed",
			name: "실패한 녹음 조각 다시 받아쓰기",
			icon: "rotate-ccw",
			checkCallback: (checking) => this.idle(checking, () => this.withSession("다시 받아쓸 세션", (s) => void this.controller.retryFailed(s))),
		});
		this.addCommand({
			id: "judge-phrase-preset",
			name: "받아쓰기 프리셋 판단",
			icon: "list-checks",
			checkCallback: (checking) => this.idle(checking, () => this.withSession("프리셋을 판단할 세션", (s) => void this.controller.judgePreset(s))),
		});
		this.addCommand({
			id: "cancel-processing",
			name: "진행 중인 작업 취소",
			icon: "x",
			checkCallback: (checking) => {
				if (this.controller.status !== "processing") return false;
				if (!checking) this.controller.cancel();
				return true;
			},
		});
		this.addCommand({ id: "open-panel", name: "녹음 패널 열기", icon: "mic", callback: () => void this.revealView() });

		this.settingTab = new VoiceContextSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		registerSegmentActions(this);
	}

	override onunload() {
		window.clearInterval(this.timer);
		this.controller.dispose();
	}

	async loadSettings() {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<VoiceContextSettings> | null) };
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.refreshPanels();
	}

	/** The panel mirrors settings that the settings tab, the agent, and the panel all change: the preset choice and the recordings folder. */
	refreshPanels() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof RecorderView) {
				leaf.view.renderPresets();
				leaf.view.renderSessions();
			}
		}
	}

	apiKey(): string | null {
		const id = this.settings.openaiSecret;
		return id ? this.app.secretStorage.getSecret(id) || null : null;
	}

	setApiKey(value: string) {
		const id = this.settings.openaiSecret || DEFAULT_SECRET_ID;
		this.app.secretStorage.setSecret(id, value);
		this.clearModelCache();
		if (this.settings.openaiSecret === id) return;
		this.settings.openaiSecret = id;
		void this.saveSettings();
	}

	azureKey(): string | null {
		const id = this.settings.azureSecret;
		return id ? this.app.secretStorage.getSecret(id) || null : null;
	}

	setAzureKey(value: string) {
		const id = this.settings.azureSecret || DEFAULT_AZURE_SECRET_ID;
		this.app.secretStorage.setSecret(id, value);
		if (this.settings.azureSecret === id) return;
		this.settings.azureSecret = id;
		void this.saveSettings();
	}

	/** Why the selected transcription provider cannot run, or null when it can. */
	transcriptionProblem(): string | null {
		if (this.settings.transcriptionProvider === "openai") return this.apiKey() ? null : "설정에서 OpenAI API 키를 지정하세요. 받아쓰기에 필요합니다.";
		if (!this.settings.azureEndpoint.trim()) return "설정에서 Azure 엔드포인트를 지정하세요. 받아쓰기에 필요합니다.";
		return this.azureKey() ? null : "설정에서 Azure 키를 지정하세요. 받아쓰기에 필요합니다.";
	}

	/** ChatGPT subscription on desktop when signed in, otherwise the API key. No silent fallback between them. */
	async summaryToken(): Promise<string> {
		if (Platform.isDesktopApp && this.chatgpt.signedIn) return this.chatgpt.accessToken();
		const key = this.apiKey();
		if (key) return key;
		throw new Error("정리에 쓸 인증이 없습니다. 설정에서 ChatGPT로 로그인하거나 OpenAI API 키를 지정하세요.");
	}

	modelOptions(kind: ModelKind): Promise<string[]> {
		let cached = this.modelCache.get(kind);
		if (!cached) {
			cached = this.fetchModels(kind).catch((e) => {
				console.warn("[voice-context] model list failed", e);
				this.modelCache.delete(kind);
				return [];
			});
			this.modelCache.set(kind, cached);
		}
		return cached;
	}

	clearModelCache() {
		this.modelCache.clear();
	}

	async startRecording(session?: TFile) {
		await this.controller.start(session);
		if (this.controller.status !== "idle") void this.revealView();
	}

	pickImport() {
		new FilePicker(this.app, listImportable(this.app), "정리할 오디오 또는 노트", (file) => void this.controller.importExisting(file), (file) => file.path).open();
	}

	async revealView() {
		// Keep focus in the editor so typing continues while the panel shows up.
		await this.app.workspace.ensureSideLeaf(VIEW_TYPE, "right", { active: false, reveal: true });
	}

	private async fetchModels(kind: ModelKind): Promise<string[]> {
		if (kind === "summary" && Platform.isDesktopApp && this.chatgpt.signedIn) return listModels(await this.chatgpt.accessToken());
		const key = this.apiKey();
		if (!key) return [];
		const ids = await listModels(key);
		return kind === "transcription"
			? ids.filter((id) => /transcribe|whisper/.test(id) && !/realtime|live/.test(id))
			: ids.filter((id) => /^(gpt|o\d|chatgpt)/.test(id) && !NOT_CHAT_MODEL.test(id));
	}

	private idle(checking: boolean, run: () => unknown) {
		if (this.controller.status !== "idle") return false;
		if (!checking) run();
		return true;
	}

	private recording(checking: boolean, run: () => unknown) {
		if (this.controller.status !== "recording" && this.controller.status !== "paused") return false;
		if (!checking) run();
		return true;
	}

	/** Session in view or under the cursor; otherwise ask. */
	pickInsert() {
		this.pickSession("현재 노트에 넣을 세션", (s) => void this.controller.insertSession(s));
	}

	private withSession(placeholder: string, run: (session: TFile) => void) {
		const session = this.controller.sessionAtCursor();
		if (session) run(session);
		else this.pickSession(placeholder, run);
	}

	private pickSession(placeholder: string, run: (session: TFile) => void) {
		const sessions = listSessions(this.app, this.settings.recordingsFolder);
		if (!sessions.length) return void new Notice(`'${this.settings.recordingsFolder}' 폴더에 세션이 없습니다.`);
		const current = this.controller.sessionAtCursor();
		const ordered = current ? [current, ...sessions.filter((s) => s !== current)] : sessions;
		new FilePicker(this.app, ordered, placeholder, run).open();
	}

	private onStatusChange() {
		const { status } = this.controller;
		const active = status === "recording" || status === "paused";
		if (active && !this.timer) this.timer = window.setInterval(() => this.tick(), 1000);
		if (!active && this.timer) {
			window.clearInterval(this.timer);
			this.timer = 0;
		}
		this.statusEl.toggle(status !== "idle");
		this.statusEl.dataset.status = status;
		this.tick();
	}

	private tick() {
		const { status } = this.controller;
		this.statusEl.setText(status === "processing" ? this.controller.stage : `${status === "paused" ? "⏸" : "●"} ${formatClock(this.controller.elapsedMs)}`);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof RecorderView) leaf.view.tick();
		}
	}
}
