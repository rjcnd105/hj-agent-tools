import { type App, FuzzySuggestModal, Modal, Setting, type TFile } from "obsidian";
import type { PresetPlan } from "./presets";
import { SECTION } from "./session";

export class FilePicker extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly files: TFile[],
		placeholder: string,
		private readonly onPick: (file: TFile) => void,
		private readonly label: (file: TFile) => string = (file) => file.basename,
	) {
		super(app);
		this.setPlaceholder(placeholder);
	}

	override getItems() {
		return this.files;
	}

	override getItemText(file: TFile) {
		return this.label(file);
	}

	override onChooseItem(file: TFile) {
		this.onPick(file);
	}
}

export type PresetChoice = "cancel" | "save" | "retranscribe";

/** Shows what the agent judged. Buttons appear only for what can actually happen. */
export function presetDecisionModal(app: App, reason: string, recommended: boolean, plan: PresetPlan, audioCount: number): Promise<PresetChoice> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		let choice: PresetChoice = "cancel";
		const pick = (next: PresetChoice) => {
			choice = next;
			modal.close();
		};
		const { contentEl } = modal;
		modal.setTitle("받아쓰기 프리셋 판단");
		contentEl.createEl("p", { text: `프리셋: ${plan.target.name}${plan.isNew ? " (새로 만듦)" : ""}` });
		if (reason) contentEl.createEl("p", { text: reason });
		if (plan.added.length) contentEl.createEl("p", { text: `추가: ${plan.added.join(", ")}` });
		if (plan.removed.length) contentEl.createEl("p", { text: `삭제: ${plan.removed.join(", ")}` });
		if (audioCount) {
			contentEl.createEl("p", { text: `다시 받아쓰기: ${recommended ? "권장" : "권장하지 않음"}` });
			contentEl.createEl("p", {
				text: `오디오 ${audioCount}개를 이 프리셋으로 다시 보내므로 받아쓰기 요금이 듭니다. 받아쓴 글 전체가 바뀌고, 이전 글은 세션 노트의 '${SECTION.previousTranscript}'에 남습니다. 정리는 '정리 다시 쓰기'로 따로 갱신합니다.`,
			});
		}
		const buttons = new Setting(contentEl).addButton((b) => b.setButtonText("취소").onClick(() => modal.close()));
		if (plan.isNew || plan.added.length || plan.removed.length) buttons.addButton((b) => b.setButtonText("프리셋만 저장").onClick(() => pick("save")));
		if (audioCount) {
			buttons.addButton((b) => {
				b.setButtonText("다시 받아쓰기").onClick(() => pick("retranscribe"));
				if (recommended) b.setCta();
			});
		}
		modal.onClose = () => resolve(choice);
		modal.open();
	});
}

export function confirmModal(app: App, message: string, cta: string): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		let confirmed = false;
		modal.setTitle("Voice Context");
		modal.contentEl.createEl("p", { text: message });
		new Setting(modal.contentEl)
			.addButton((b) => b.setButtonText("취소").onClick(() => modal.close()))
			.addButton((b) =>
				b
					.setButtonText(cta)
					.setWarning()
					.onClick(() => {
						confirmed = true;
						modal.close();
					}),
			);
		modal.onClose = () => resolve(confirmed);
		modal.open();
	});
}
