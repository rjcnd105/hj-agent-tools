import { AbstractInputSuggest, type App, type ButtonComponent, Notice, Platform, PluginSettingTab, type Setting, type SettingDefinitionItem } from "obsidian";
import type VoiceContextPlugin from "./main";
import { modelSuggestions } from "./markdown";
import { explainError } from "./openai";
import { type PhrasePreset, parsePhrases } from "./presets";
import type { TranscribeStyle } from "./protocol";

export interface VoiceContextSettings {
	recordingsFolder: string;
	segmentMinutes: number;
	transcriptionModel: string;
	transcriptionLanguages: string;
	transcriptionProvider: "openai" | "azure";
	/** Azure resource name or full endpoint. */
	azureEndpoint: string;
	azureModel: string;
	/** SecretStorage id of the Azure key, not the key itself. */
	azureSecret: string;
	azureTranscribeStyle: TranscribeStyle;
	/** Audio milliseconds Azure reported, per UTC month ("2026-11"). */
	azureUsageMs: Record<string, number>;
	phrasePresets: PhrasePreset[];
	/** Name of the preset new recordings use. Empty means none. */
	activePreset: string;
	summaryModel: string;
	summaryPrompt: string;
	/** SecretStorage id of the OpenAI API key, not the key itself. */
	openaiSecret: string;
	includeExternalUrls: boolean;
	maxCharsPerSource: number;
	maxContextChars: number;
	/** Public OAuth client registration. Tokens stay in SecretStorage. */
	chatgpt: { hostId: string; clientId: string; email: string | null } | null;
}

export const DEFAULT_SUMMARY_PROMPT = `녹음을 받아쓴 글과 참고 자료를 바탕으로 노트에 넣을 정리를 한국어로 작성하세요.
- 핵심 내용, 결정 사항, 할 일(- [ ] 체크리스트), 남은 질문 순서로 정리하고, 내용이 없는 항목은 생략합니다.
- 참고 자료는 받아쓴 글을 이해하고 용어와 맥락을 보완하는 데만 쓰고, 받아쓴 글이나 자료에 없는 사실을 지어내지 않습니다.
- 사용자가 녹음 중에 남긴 메모에 정리 방식에 관한 지시가 있으면 그 지시를 우선합니다.`;

export const DEFAULT_SECRET_ID = "voice-context-openai";
export const DEFAULT_AZURE_SECRET_ID = "voice-context-azure";

export const DEFAULT_SETTINGS: VoiceContextSettings = {
	recordingsFolder: "Recordings",
	segmentMinutes: 3,
	transcriptionModel: "gpt-transcribe",
	transcriptionLanguages: "ko",
	transcriptionProvider: "openai",
	azureEndpoint: "",
	azureModel: "MAI-Transcribe-2",
	azureSecret: "",
	azureTranscribeStyle: "verbatim",
	azureUsageMs: {},
	phrasePresets: [],
	activePreset: "",
	summaryModel: "gpt-6.1-sol",
	summaryPrompt: DEFAULT_SUMMARY_PROMPT,
	openaiSecret: "",
	includeExternalUrls: true,
	maxCharsPerSource: 6000,
	maxContextChars: 40000,
	chatgpt: null,
};

type ModelKey = "transcriptionModel" | "summaryModel";

class ModelSuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		input: HTMLInputElement,
		private readonly models: () => Promise<string[]>,
		private readonly onPick: (model: string) => void,
	) {
		super(app, input);
	}

	protected override async getSuggestions(query: string) {
		return modelSuggestions(await this.models(), query);
	}

	override renderSuggestion(model: string, el: HTMLElement) {
		el.setText(model);
	}

	override selectSuggestion(model: string) {
		this.setValue(model);
		this.onPick(model);
		this.close();
	}
}

const AZURE_COST_URL = "https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/costanalysis";

const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)}분`;

export class VoiceContextSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: VoiceContextPlugin,
	) {
		super(app, plugin);
	}

	override async setControlValue(key: string, value: unknown) {
		await super.setControlValue(key, value);
		if (key === "transcriptionProvider") this.update();
		this.plugin.refreshPanels();
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		const usesAzure = () => this.plugin.settings.transcriptionProvider === "azure";
		return [
			{
				type: "group",
				heading: "받아쓰기",
				items: [
					{
						name: "받아쓰기 제공자",
						desc: "자동으로 다른 제공자로 넘어가지 않습니다. ChatGPT 구독으로는 받아쓸 수 없습니다.",
						control: { type: "dropdown", key: "transcriptionProvider", options: { openai: "OpenAI", azure: "Azure Speech (MAI-Transcribe)" } },
					},
					{
						name: "받아쓰기 언어",
						desc: "녹음에서 말하는 언어. ko, en처럼 적고 여러 개면 쉼표로 구분합니다. gpt-transcribe가 아닌 모델은 첫 번째만 쓰고, Azure는 비워 두면 언어를 자동으로 감지합니다.",
						control: { type: "text", key: "transcriptionLanguages" },
					},
					{
						name: "Azure 엔드포인트",
						desc: "Azure Speech를 쓸 수 있는 리소스의 이름 또는 엔드포인트 URL. MAI-Transcribe 지원 지역에 만든 리소스여야 합니다.",
						visible: usesAzure,
						control: { type: "text", key: "azureEndpoint", placeholder: "my-speech-resource" },
					},
					{
						name: "Azure 키",
						desc: `Obsidian 키체인에 저장되어 동기화되지 않습니다. 키체인 항목: ${this.plugin.settings.azureSecret || DEFAULT_AZURE_SECRET_ID}`,
						visible: usesAzure,
						render: (setting) =>
							this.renderSecret(setting, {
								label: "Azure 키",
								placeholder: "Azure 리소스 키",
								read: () => this.plugin.azureKey(),
								write: (value) => this.plugin.setAzureKey(value),
							}),
					},
					{
						name: "Azure 모델",
						desc: "대소문자를 구분합니다.",
						visible: usesAzure,
						control: { type: "text", key: "azureModel" },
					},
					{
						name: "Azure 사용량",
						desc: `이번 달(UTC) ${minutes(this.plugin.settings.azureUsageMs[new Date().toISOString().slice(0, 7)] ?? 0)}, 전체 ${minutes(Object.values(this.plugin.settings.azureUsageMs).reduce((sum, ms) => sum + ms, 0))}. 이 플러그인이 응답을 받은 오디오 길이의 합이라 취소한 요청과 다른 앱의 사용량은 빠집니다. 청구 금액은 Azure 비용 분석에서 확인합니다.`,
						visible: usesAzure,
						render: (setting: Setting) => void setting.addButton((b) => b.setButtonText("비용 분석 열기").onClick(() => window.open(AZURE_COST_URL))),
					},
					{
						name: "받아쓰기 스타일",
						desc: "verbatim은 말한 그대로, clean은 군말과 말 더듬을 지우고 읽기 좋게 받아씁니다.",
						visible: usesAzure,
						control: { type: "dropdown", key: "azureTranscribeStyle", options: { verbatim: "verbatim", clean: "clean" } },
					},
					{
						name: "새 녹음에 쓸 프리셋",
						desc: "프리셋의 용어를 음성 인식 힌트(phraseList)로 보냅니다.",
						visible: usesAzure,
						control: { type: "dropdown", key: "activePreset", options: { "": "없음", ...Object.fromEntries(this.plugin.settings.phrasePresets.map((p) => [p.name, p.name])) } },
					},
					...this.plugin.settings.phrasePresets.map((preset) => ({
						name: preset.name,
						desc: "용어는 한 줄에 하나씩 또는 쉼표로 구분합니다.",
						visible: usesAzure,
						render: (setting: Setting) => this.renderPreset(setting, preset),
					})),
					{
						name: "프리셋 추가",
						desc: "'받아쓰기 프리셋 판단' 명령을 쓰면 에이전트가 세션을 읽고 프리셋을 고르거나 고치도록 제안합니다.",
						visible: usesAzure,
						render: (setting: Setting) => void setting.addButton((b) => b.setButtonText("추가").onClick(() => void this.addPreset())),
					},
				],
			},
			{
				type: "group",
				heading: "OpenAI",
				items: [
					{
						name: "API 키",
						desc: `OpenAI로 받아쓸 때 쓰고, ChatGPT로 로그인하지 않았다면 정리에도 씁니다. Obsidian 키체인에 저장되어 동기화되지 않습니다. 키체인 항목: ${this.plugin.settings.openaiSecret || DEFAULT_SECRET_ID}`,
						render: (setting) =>
							this.renderSecret(setting, {
								label: "API 키",
								placeholder: "sk-…",
								read: () => this.plugin.apiKey(),
								write: (value) => this.plugin.setApiKey(value),
							}),
					},
					{
						name: "받아쓰기 모델",
						desc: "녹음을 글로 옮기는 모델.",
						visible: () => !usesAzure(),
						render: (setting) => this.renderModel(setting, "transcriptionModel"),
					},
				],
			},
			{
				type: "group",
				heading: "ChatGPT 구독",
				visible: Platform.isDesktopApp,
				items: [{ name: "ChatGPT로 로그인", render: (setting) => this.renderChatGPT(setting) }],
			},
			{
				type: "group",
				heading: "정리",
				items: [
					{
						name: "정리 모델",
						desc: "받아쓴 글을 정리하는 모델. ChatGPT로 로그인했다면 구독 모델, 아니면 API 모델에서 고릅니다.",
						render: (setting) => this.renderModel(setting, "summaryModel"),
					},
					{
						name: "정리 프롬프트",
						desc: "녹음별 지시는 녹음 중 context 입력란에 적으면 됩니다.",
						control: { type: "textarea", key: "summaryPrompt", rows: 6, defaultValue: DEFAULT_SUMMARY_PROMPT },
					},
				],
			},
			{
				type: "group",
				heading: "녹음",
				items: [
					{ name: "세션 폴더", desc: "세션 노트와 오디오를 저장할 폴더.", control: { type: "folder", key: "recordingsFolder" } },
					{
						name: "녹음 분할 간격",
						desc: "이 간격마다 오디오를 파일로 저장하고 바로 받아씁니다.",
						control: { type: "slider", key: "segmentMinutes", min: 1, max: 10, step: 1, displayFormat: (v) => `${v}분` },
					},
				],
			},
			{
				type: "group",
				heading: "Context",
				items: [
					{ name: "외부 URL 본문 가져오기", desc: "선택 영역과 메모 속 웹 링크의 본문을 정리에 포함합니다.", control: { type: "toggle", key: "includeExternalUrls" } },
					{ name: "출처별 최대 글자 수", control: { type: "number", key: "maxCharsPerSource", min: 500, step: 500 } },
					{ name: "전체 최대 글자 수", control: { type: "number", key: "maxContextChars", min: 2000, step: 1000 } },
				],
			},
		];
	}

	private async savePresets(presets: PhrasePreset[], activePreset = this.plugin.settings.activePreset) {
		Object.assign(this.plugin.settings, { phrasePresets: presets, activePreset });
		await this.plugin.saveSettings();
		this.update();
	}

	private async addPreset() {
		const names = new Set(this.plugin.settings.phrasePresets.map((p) => p.name));
		let name = "새 프리셋";
		for (let n = 2; names.has(name); n++) name = `새 프리셋 ${n}`;
		await this.savePresets([...this.plugin.settings.phrasePresets, { name, phrases: [] }]);
	}

	private renderPreset(setting: Setting, preset: PhrasePreset) {
		const { settings } = this.plugin;
		setting.settingEl.addClass("vc-preset");
		setting.addText((text) => {
			text.setValue(preset.name).setPlaceholder("프리셋 이름");
			text.inputEl.setAttr("aria-label", "프리셋 이름");
			text.inputEl.addEventListener("change", () => {
				const name = text.getValue().trim();
				if (name === preset.name) return;
				if (!name || settings.phrasePresets.some((p) => p.name === name)) {
					text.setValue(preset.name);
					if (name) new Notice(`'${name}' 프리셋이 이미 있습니다.`);
					return;
				}
				void this.savePresets(
					settings.phrasePresets.map((p) => (p.name === preset.name ? { ...p, name } : p)),
					settings.activePreset === preset.name ? name : settings.activePreset,
				);
			});
		});
		setting.addTextArea((area) => {
			// Definitions outlive a close and reopen, so read the saved phrases, not the captured preset.
			const saved = settings.phrasePresets.find((p) => p.name === preset.name) ?? preset;
			area.setValue(saved.phrases.join("\n")).setPlaceholder("고유명사\n약어");
			area.inputEl.setAttr("aria-label", `${preset.name} 용어`);
			area.inputEl.rows = 4;
			area.inputEl.addEventListener("change", () => {
				settings.phrasePresets = settings.phrasePresets.map((p) => (p.name === preset.name ? { ...p, phrases: parsePhrases(area.getValue()) } : p));
				void this.plugin.saveSettings();
			});
		});
		setting.addExtraButton((button) =>
			button
				.setIcon("trash-2")
				.setTooltip(`${preset.name} 삭제`)
				.onClick(() => {
					void this.savePresets(
						settings.phrasePresets.filter((p) => p.name !== preset.name),
						settings.activePreset === preset.name ? "" : settings.activePreset,
					);
				}),
		);
	}

	private renderSecret(setting: Setting, secret: { label: string; placeholder: string; read: () => string | null; write: (value: string) => void }) {
		setting.settingEl.addClass("vc-api-key");
		let input: HTMLInputElement;
		setting.addText((text) => {
			input = text.inputEl;
			input.type = "password";
			input.autocomplete = "off";
			input.spellcheck = false;
			text.setPlaceholder(secret.placeholder).setValue(secret.read() ?? "");
			input.addEventListener("change", () => {
				const value = input.value.trim();
				secret.write(value);
				new Notice(value ? `${secret.label}를 저장했습니다.` : `${secret.label}를 지웠습니다.`);
			});
		});
		setting.addExtraButton((button) => {
			const show = (visible: boolean) => {
				input.type = visible ? "text" : "password";
				button.setIcon(visible ? "eye-off" : "eye").setTooltip(visible ? `${secret.label} 숨기기` : `${secret.label} 보기`);
			};
			show(false);
			button.onClick(() => show(input.type === "password"));
		});
	}

	private renderModel(setting: Setting, key: ModelKey) {
		setting.addText((text) => {
			const kind = key === "summaryModel" ? "summary" : "transcription";
			const save = async (value: string) => {
				this.plugin.settings[key] = value;
				await this.plugin.saveSettings();
			};
			text.setValue(this.plugin.settings[key]);
			text.inputEl.addEventListener("change", async () => {
				const value = text.getValue().trim();
				if (!value) return void text.setValue(this.plugin.settings[key]);
				await save(value);
				const models = await this.plugin.modelOptions(kind);
				if (models.length && !models.includes(value)) new Notice(`'${value}'은(는) 모델 목록에 없습니다. 이름을 확인하세요.`);
			});
			new ModelSuggest(this.app, text.inputEl, () => this.plugin.modelOptions(kind), (model) => void save(model));
		});
	}

	private renderChatGPT(setting: Setting) {
		const auth = this.plugin.chatgpt;
		let button: ButtonComponent | undefined;
		const refresh = () => {
			const email = this.plugin.settings.chatgpt?.email;
			setting.setDesc(
				auth.signedIn
					? `${email ?? "로그인됨"} — 정리에 ChatGPT 구독 사용량을 씁니다. 받아쓰기는 구독으로 처리할 수 없어 받아쓰기 제공자의 키를 씁니다.`
					: "로그인하면 정리에 ChatGPT 구독(Plus/Pro)을 씁니다. 받아쓰기는 지원되지 않아 받아쓰기 제공자의 키를 씁니다.",
			);
			button?.setButtonText(auth.signedIn ? "로그아웃" : "로그인");
		};
		setting.addButton((b) => {
			button = b;
			b.onClick(async () => {
				b.setDisabled(true);
				try {
					if (auth.signedIn) await auth.signOut();
					else {
						new Notice("브라우저에서 ChatGPT 로그인을 완료하세요.");
						await auth.signIn();
						new Notice("ChatGPT에 로그인했습니다.");
					}
					this.plugin.clearModelCache();
				} catch (e) {
					console.error("[voice-context] ChatGPT sign-in failed", e);
					new Notice(`ChatGPT 로그인 실패: ${explainError(e)}`);
				} finally {
					b.setDisabled(false);
					refresh();
				}
			});
		});
		refresh();
	}
}
