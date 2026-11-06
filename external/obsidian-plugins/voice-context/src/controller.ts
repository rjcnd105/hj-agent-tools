import { type App, type Editor, MarkdownView, Notice, Platform, type TFile } from "obsidian";
import { maiAudio, transcribeAzure } from "./azure";
import { expandContext } from "./context";
import type VoiceContextPlugin from "./main";
import {
	FAILED_RE,
	type Insertion,
	applyInsertions,
	blockIdAt,
	dateFromSessionId,
	demoteHeadings,
	appendToSection,
	extractSection,
	failedMarker,
	findBlock,
	findLine,
	findPending,
	findSection,
	formatDateTime,
	formatTime,
	importHeading,
	numberLines,
	padIndex,
	parseContextEntries,
	parseInsertions,
	pendingMarker,
	removeSegmentLines,
	renderBlock,
	renderCallout,
	renderContextEntry,
	sessionId,
	stripMarkers,
	transcriptFromNote,
} from "./markdown";
import { confirmModal, presetDecisionModal } from "./modals";
import { editNote, readNote } from "./notes";
import { explainError, generate, transcribe } from "./openai";
import { type PhrasePreset, type PresetDecision, parsePresetDecision, planPreset } from "./presets";
import { Cancelled, cancellable, splitList, transcriptionFields, withRetry } from "./protocol";
import { type Segment, SegmentRecorder, openMicrophone } from "./recorder";
import {
	SECTION,
	addDuration,
	addNoteLink,
	appendSection,
	createSession,
	durationMinutes,
	findSession,
	importedSession,
	linkedNotes,
	nextSegmentIndex,
	saveAudio,
	sessionAudio,
	sessionIdOf,
} from "./session";
import { ScreenWakeLock } from "./wakelock";

export type Status = "idle" | "recording" | "paused" | "processing";

export interface Run {
	session: TFile;
	id: string;
	isContinue: boolean;
	previousTranscript: string;
	/** `### …` line that opens this run in the transcript section. */
	heading: string;
	/** Note that holds the pending marker or the existing block. */
	target: TFile | null;
	recorder: SegmentRecorder;
	/** Serializes every write to the session note. */
	queue: Promise<void>;
	texts: string[];
	contexts: string[];
	pendingSegments: number;
	failed: number;
}

type Outcome = Pick<Run, "session" | "id" | "isContinue" | "previousTranscript" | "heading" | "target" | "texts" | "failed">;

interface Location {
	file: TFile;
	kind: "block" | "pending";
}

const MIN_SEGMENT_MS = 800;
/** A container with no audio frames (e.g. the input went dead) is only a ~100-byte header. */
const MIN_AUDIO_BYTES = 1024;
const PROMPT_TAIL_CHARS = 600;
const MIME_BY_EXT: Record<string, string> = { webm: "audio/webm", m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav" };
/** Upload limits of the transcription APIs, in MB. Azure's is the lower of its two documented values. */
const MAX_UPLOAD_MB = { openai: 25, azure: 250 };
const LARGE_NOTE_BYTES = 100 * 1024;

const FORMAT_RULES = `정리 마크다운 규칙:
- #, ##, ### 제목은 쓰지 말고, 필요하면 #### 소제목과 목록을 씁니다.
- 전체를 코드 블록으로 감싸지 않습니다.
- 참고 자료의 노트를 언급할 때는 [[노트 이름]] 링크를 그대로 씁니다.
- <context>는 받아쓴 글을 이해하기 위한 참고 자료이며 요약 대상이 아닙니다. 받아쓴 글에 나오지 않은 내용을 핵심 내용, 결정 사항, 할 일에 넣지 않습니다. 단, 사용자가 메모로 남긴 정리 지시는 따릅니다.
- 받아쓴 글의 고유명사나 용어가 잘못 들린 것으로 보이면 <context>의 표기로 바로잡습니다.`;

const CREATE_RULES = "응답으로 정리 본문 마크다운만 출력합니다.";

const UPDATE_RULES = `이번에는 이어 녹음한 내용을 기존 정리에 반영합니다.
- <current_summary>의 각 줄 앞에는 "번호| "가 붙어 있습니다. 사용자가 직접 고친 줄일 수 있으니 기존 줄은 고치거나 지우지 말고 새 줄을 삽입만 합니다.
- <new_transcript>에서 나온 내용 중 기존 정리에 없는 것만 가장 알맞은 줄 뒤에 넣습니다. 하위 항목이면 들여쓰기를 맞춥니다.
- 새 내용이 기존 줄과 충돌하면 그 줄 바로 뒤에 "→ 갱신: …" 줄을 넣습니다. 기존 줄이 목록 항목이면 그 하위 항목("  - → 갱신: …")으로 넣습니다.
- 응답으로 JSON 하나만 출력합니다: {"insertions":[{"after_line":<기존 줄 번호, 맨 앞은 0>,"text":"<삽입할 마크다운, 줄 번호 없이>"}]}
- 넣을 내용이 없으면 {"insertions":[]}를 출력합니다.`;

const PRESET_RULES = `음성 인식 모델의 키워드 힌트(phraseList) 프리셋을 관리합니다. 힌트는 어려운 고유명사, 약어, 전문 용어를 오디오에서 더 잘 알아듣게 하지만 강제 출력은 아닙니다.
<presets>는 지금 있는 프리셋, <transcript>는 현재 받아쓴 글, <context>는 사용자가 남긴 메모입니다.
- preset: 녹음 주제에 맞는 기존 프리셋의 이름을 그대로 씁니다. 맞는 프리셋이 없고 추가할 용어가 있으면 주제를 나타내는 짧은 새 이름을 씁니다. 둘 다 아니면 null입니다.
- add: 그 프리셋에 없는 고유명사, 약어, 전문 용어의 올바른 표기. 메모에 올바른 표기가 있거나 글 안에서 오인식이 드러난 용어만, 꼭 필요한 만큼 넣습니다. 이미 바르게 받아써진 용어, 일반 단어와 문장, 잘못 들린 표기 자체, 근거 없는 추측은 넣지 않습니다. 힌트가 많으면 관계없는 구간의 받아쓰기가 나빠질 수 있습니다.
- remove: 이번 프리셋에서 틀린 표기로 드러난 항목만 넣습니다. 이번 글에 나오지 않았다는 이유만으로 지우지 않습니다.
- retranscribe: 이 프리셋으로 오디오를 다시 받아쓰면 핵심 내용(결정, 이름, 날짜, 수치, 할 일)이 실제로 더 정확해질 것 같을 때만 true입니다. 지금 글로 핵심을 알아볼 수 있으면 false입니다.
- reason: 판단 근거를 한국어 한두 문장으로 씁니다.
응답으로 JSON 하나만 출력합니다: {"preset":"이름"|null,"add":["…"],"remove":["…"],"retranscribe":false,"reason":"…"}`;

const tag = (name: string, body: string) => (body.trim() ? `<${name}>\n${body.trim()}\n</${name}>` : "");
const joinTags = (...parts: string[]) => parts.filter(Boolean).join("\n\n");
const transcriptOf = (sessionText: string) => stripMarkers(extractSection(sessionText, SECTION.transcript));
const unfence = (s: string) => s.trim().replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/, "$1").trim();

/** Reading view keeps a hidden editor that is never saved, so only source mode can take edits. */
const liveEditor = (view: MarkdownView | null) => (view?.getMode() === "source" ? view.editor : null);

function report(message: string, e: unknown, suffix = "", timeout?: number) {
	console.error("[voice-context]", message, e);
	new Notice(`${message}: ${explainError(e)}${suffix ? ` ${suffix}` : ""}`, timeout);
}

export class RecordingController {
	status: Status = "idle";
	/** What a processing job is doing right now, for the status bar and the panel. */
	stage = "";
	run: Run | null = null;
	readonly wakeLock = new ScreenWakeLock(() => new Notice("화면 꺼짐 방지를 쓸 수 없습니다. 녹음하는 동안 화면을 켜 두세요.", 10_000));
	private readonly listeners = new Set<() => void>();
	private abort = new AbortController();

	constructor(private readonly plugin: VoiceContextPlugin) {}

	private get app(): App {
		return this.plugin.app;
	}

	private get settings() {
		return this.plugin.settings;
	}

	get elapsedMs() {
		return this.run?.recorder.elapsedMs ?? 0;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit() {
		for (const listener of this.listeners) listener();
	}

	private setStatus(status: Status, stage = "") {
		this.status = status;
		this.stage = stage;
		if (status === "idle") this.abort = new AbortController();
		// A sleeping phone can interrupt the microphone and in-flight requests. A pause needs neither.
		this.wakeLock.set(Platform.isMobileApp && (status === "recording" || status === "processing"));
		this.emit();
	}

	private setStage(stage: string) {
		this.stage = stage;
		this.emit();
	}

	cancel() {
		this.abort.abort(new Cancelled("취소했습니다"));
	}

	/** The note the user is writing in, even while the sidebar panel has focus. */
	workingView(): MarkdownView | null {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active) return active;
		const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
		return leaf?.view instanceof MarkdownView ? leaf.view : null;
	}

	/** Session of the note in view, or of the block/marker under the cursor. */
	sessionAtCursor(): TFile | null {
		const view = this.workingView();
		if (!view?.file) return null;
		if (sessionIdOf(this.app, view.file)) return view.file;
		const editor = view.editor;
		const id = blockIdAt(editor.getValue(), editor.posToOffset(editor.getCursor()));
		return id ? findSession(this.app, this.settings.recordingsFolder, id) : null;
	}

	async start(continueFrom?: TFile) {
		if (this.status !== "idle") {
			new Notice("이미 녹음하거나 정리하는 중입니다.");
			return;
		}
		const problem = this.plugin.transcriptionProblem();
		if (problem) {
			new Notice(problem);
			return;
		}
		const existingId = continueFrom ? sessionIdOf(this.app, continueFrom) : null;
		if (continueFrom && !existingId) {
			new Notice("Voice Context 세션 노트가 아닙니다.");
			return;
		}
		let stream: MediaStream;
		try {
			stream = await openMicrophone();
		} catch (e) {
			report("마이크를 열 수 없습니다", e);
			return;
		}

		const view = this.workingView();
		const note = view?.file ?? null;
		const editor = liveEditor(view);
		const selection = editor?.somethingSelected() ? stripMarkers(editor.getSelection()) : "";
		const now = new Date();
		const id = existingId ?? sessionId(now);
		try {
			let session = continueFrom ?? null;
			let target: TFile | null = null;
			let previousTranscript = "";
			if (!session) {
				// Without a working note the summary lands in the session note itself.
				session = await createSession(this.app, this.settings.recordingsFolder, id, now, note, note ? "" : pendingMarker(id));
				if (view && note) await this.insertPending(view, id);
				target = note ?? session;
			} else {
				previousTranscript = transcriptOf(await readNote(this.app, session));
				target = (await this.locate(session, id, note))?.file ?? null;
				if (!target && view && note) {
					await this.insertPending(view, id);
					target = note;
					await addNoteLink(this.app, session, note);
				}
			}
			const heading = `### ${formatDateTime(now)}${continueFrom ? " · 이어 녹음" : ""}`;
			await appendSection(this.app, session, SECTION.transcript, heading);

			const recorder = new SegmentRecorder(
				stream,
				this.settings.segmentMinutes * 60_000,
				nextSegmentIndex(this.app, session),
				(segment) => {
					run.pendingSegments++;
					this.emit();
					void this.enqueue(run, () => this.processSegment(run, segment));
				},
				() => void this.stop(),
			);
			const run: Run = {
				session,
				id,
				isContinue: !!continueFrom,
				previousTranscript,
				heading,
				target,
				recorder,
				queue: Promise.resolve(),
				texts: [],
				contexts: [],
				pendingSegments: 0,
				failed: 0,
			};
			this.run = run;
			recorder.start();
			this.setStatus("recording");
			if (selection && note) void this.addContext(`선택 영역 · [[${this.app.metadataCache.fileToLinktext(note, session.path, true)}]]`, selection);
		} catch (e) {
			for (const track of stream.getTracks()) track.stop();
			this.run = null;
			this.setStatus("idle");
			report("녹음을 시작할 수 없습니다", e);
		}
	}

	togglePause() {
		const run = this.run;
		if (!run) return;
		if (this.status === "recording") {
			run.recorder.pause();
			this.setStatus("paused");
		} else if (this.status === "paused") {
			run.recorder.resume();
			this.setStatus("recording");
		}
	}

	async stop() {
		const run = this.run;
		if (!run || this.status === "processing") return;
		this.setStatus("processing", "받아쓰기 마무리 중…");
		try {
			await run.recorder.stop();
			await this.drain(run);
			await addDuration(this.app, run.session, run.recorder.elapsedMs);
			await this.finish(run);
		} catch (e) {
			if (e instanceof Cancelled) await this.keepAfterCancel(run);
			else report("정리 중 오류", e);
		} finally {
			this.run = null;
			this.setStatus("idle");
		}
	}

	/** Adds context while recording. Returns once queued; the session write follows in order. */
	async addContext(title: string, body: string): Promise<boolean> {
		const run = this.run;
		if (!run || this.status === "processing") {
			new Notice("녹음 중에만 context를 추가할 수 있습니다.");
			return false;
		}
		const clean = stripMarkers(body);
		if (!clean) return false;
		const heading = `${formatTime(new Date())} · ${title}`;
		run.contexts.push(heading);
		this.emit();
		void this.enqueue(run, () => appendSection(this.app, run.session, SECTION.context, renderContextEntry(heading, clean)));
		new Notice("context에 추가했습니다.");
		return true;
	}

	addSelection(editor: Editor, file: TFile | null) {
		const run = this.run;
		if (!run) return;
		const source = file ? ` · [[${this.app.metadataCache.fileToLinktext(file, run.session.path, true)}]]` : "";
		void this.addContext(`선택 영역${source}`, editor.getSelection());
	}

	/** Overwrites the whole summary block from the full transcript (asks first if one exists). */
	async rewrite(session: TFile) {
		const id = sessionIdOf(this.app, session);
		if (!id) return void new Notice("Voice Context 세션 노트가 아닙니다.");
		if (this.status !== "idle") return void new Notice("녹음이나 정리가 끝난 뒤에 실행하세요.");
		this.setStatus("processing", "정리 중…");
		try {
			const text = await readNote(this.app, session);
			const transcript = transcriptOf(text);
			if (!transcript) return void new Notice("세션에 받아쓴 내용이 없습니다.");
			const found = await this.locate(session, id, this.workingView()?.file ?? null);
			if (found?.kind === "block" && !(await confirmModal(this.app, "기존 정리를 새로 씁니다. 직접 고친 내용도 바뀝니다. 계속할까요?", "다시 쓰기"))) return;
			if (await this.writeBlock(session, id, found, transcript, await this.context(session, text), durationMinutes(text))) {
				new Notice("정리를 다시 썼습니다.");
			}
		} catch (e) {
			if (e instanceof Cancelled) new Notice("취소했습니다. 기존 정리는 그대로입니다.");
			else report("정리 실패", e);
		} finally {
			this.setStatus("idle");
		}
	}

	async retryFailed(session: TFile) {
		if (this.status !== "idle") return void new Notice("녹음이나 정리가 끝난 뒤에 실행하세요.");
		const paths = [...extractSection(await readNote(this.app, session), SECTION.transcript).matchAll(FAILED_RE)].map((m) => m[1]!);
		if (!paths.length) return void new Notice("실패한 녹음 조각이 없습니다.");
		this.setStatus("processing", `다시 받아쓰는 중… 1/${paths.length}`);
		let done = 0;
		try {
			for (const [i, path] of paths.entries()) {
				this.setStage(`다시 받아쓰는 중… ${i + 1}/${paths.length}`);
				const file = this.app.vault.getFileByPath(path);
				if (!file) continue;
				try {
					const data = await this.app.vault.readBinary(file);
					const text = data.byteLength < MIN_AUDIO_BYTES ? "" : await this.transcribeAudio(data, file.name, MIME_BY_EXT[file.extension] ?? "audio/webm", "");
					await editNote(this.app, session, (cur) => {
						const r = findLine(cur, failedMarker(path));
						return r ? cur.slice(0, r.from) + text + cur.slice(r.to) : cur;
					});
					done++;
				} catch (e) {
					if (e instanceof Cancelled) break;
					report(`${file.name} 받아쓰기 실패`, e);
				}
			}
		} finally {
			this.setStatus("idle");
		}
		new Notice(`${done}/${paths.length}개 녹음 조각을 다시 받아썼습니다. 정리에 반영하려면 '정리 다시 쓰기'를 실행하세요.`, 10_000);
	}

	/** The agent reads the transcript and proposes a preset and its edits. The user confirms, since a re-transcription is billed and replaces the text. */
	async judgePreset(session: TFile) {
		if (!sessionIdOf(this.app, session)) return void new Notice("Voice Context 세션 노트가 아닙니다.");
		if (this.status !== "idle") return void new Notice("녹음이나 정리가 끝난 뒤에 실행하세요.");
		if (this.settings.transcriptionProvider !== "azure") return void new Notice("프리셋은 Azure Speech로 받아쓸 때만 쓰입니다.");
		this.setStatus("processing", "프리셋 판단 중…");
		let decision: PresetDecision | null = null;
		try {
			const text = await readNote(this.app, session);
			const transcript = transcriptOf(text);
			if (!transcript) return void new Notice("세션에 받아쓴 내용이 없습니다.");
			const presets = this.settings.phrasePresets;
			const input = joinTags(tag("presets", JSON.stringify(presets)), tag("transcript", transcript), tag("context", extractSection(text, SECTION.context)));
			const judged = parsePresetDecision(await this.llm(PRESET_RULES, input, false));
			const plan = planPreset(presets, judged);
			if (!plan) return void new Notice(`맞는 프리셋이 없습니다. ${judged.reason}`, 10_000);
			const audioCount = sessionAudio(this.app, session, text).length;
			if (!audioCount && !plan.isNew && !plan.added.length && !plan.removed.length) return void new Notice(`'${plan.target.name}'이(가) 맞지만 바꿀 내용과 다시 받아쓸 오디오가 없습니다.`, 10_000);
			const choice = await presetDecisionModal(this.app, judged.reason, judged.retranscribe, plan, audioCount);
			if (choice !== "cancel") decision = { ...judged, retranscribe: choice === "retranscribe" };
		} catch (e) {
			if (e instanceof Cancelled) new Notice("취소했습니다.");
			else report("프리셋 판단 실패", e);
		} finally {
			this.setStatus("idle");
		}
		if (decision) await this.applyPresetDecision(session, decision);
	}

	/** Saves the preset, then optionally re-transcribes with it. Also the entry point for an outside agent that judged on its own. The preset for new recordings stays as set. */
	async applyPresetDecision(session: TFile, decision: PresetDecision) {
		if (this.status !== "idle") return void new Notice("녹음이나 정리가 끝난 뒤에 실행하세요.");
		const plan = planPreset(this.settings.phrasePresets, decision);
		if (!plan) return void new Notice("적용할 프리셋이 없습니다.");
		this.setStatus("processing", "프리셋 저장 중…");
		try {
			this.settings.phrasePresets = plan.presets;
			await this.plugin.saveSettings();
			this.plugin.settingTab.update();
			const saved = `프리셋 '${plan.target.name}' 저장: +${plan.added.length} -${plan.removed.length}.`;
			if (!decision.retranscribe) return void new Notice(saved);
			await this.retranscribe(session, plan.target);
			new Notice(`${saved} 다시 받아썼습니다. 정리에 반영하려면 '정리 다시 쓰기'를 실행하세요.`, 10_000);
		} catch (e) {
			if (e instanceof Cancelled) new Notice("취소했습니다. 받아쓴 글은 그대로입니다.");
			else report("다시 받아쓰기 실패", e, "받아쓴 글은 그대로입니다.", 10_000);
		} finally {
			this.setStatus("idle");
		}
	}

	/** All or nothing: one failed segment leaves the note untouched. The old text moves to its own section because it can hold edits and text from deleted audio. */
	private async retranscribe(session: TFile, preset: PhrasePreset) {
		const files = sessionAudio(this.app, session, await readNote(this.app, session));
		if (!files.length) throw new Error("세션에 다시 받아쓸 오디오가 없습니다");
		const texts: string[] = [];
		for (const [i, file] of files.entries()) {
			this.setStage(`다시 받아쓰는 중… ${i + 1}/${files.length}`);
			const text = await this.transcribeAudio(await this.app.vault.readBinary(file), file.name, MIME_BY_EXT[file.extension] ?? "audio/webm", "", preset.phrases);
			if (text) texts.push(text);
		}
		if (!texts.length) throw new Error("인식된 음성이 없습니다");
		const now = formatDateTime(new Date());
		await editNote(this.app, session, (cur) => {
			const r = findSection(cur, SECTION.transcript);
			if (!r) throw new Error(`세션 노트에 '${SECTION.transcript}' 섹션이 없습니다`);
			const old = cur.slice(r.from, r.to).trim();
			const fresh = [`### ${now} · 다시 받아쓰기 · ${preset.name}`, ...texts].join("\n\n");
			const replaced = `${cur.slice(0, r.from)}\n${fresh}\n\n${cur.slice(r.to)}`;
			return old ? appendToSection(replaced, SECTION.previousTranscript, `### ${now} 이전\n\n${old}`) : replaced;
		});
	}

	/** Removes one audio segment: its embed and failed marker from the note, then the file. The transcript has no per-segment mapping, so it stays. */
	async deleteSegment(session: TFile, file: TFile) {
		if (this.status !== "idle") return void new Notice("녹음이나 정리가 끝난 뒤에 실행하세요.");
		if (!(await confirmModal(this.app, `${file.name}을(를) 삭제합니다. 받아쓴 글과 정리는 그대로 남습니다. 계속할까요?`, "삭제"))) return;
		// Another command can start a job while a modal is open.
		if (this.status !== "idle") return void new Notice("녹음이나 정리가 끝난 뒤에 실행하세요.");
		this.setStatus("processing", "오디오 삭제 중…");
		try {
			// The note goes first: links stop resolving once the file is gone, and a failure then leaves an orphan file, not a dangling embed.
			const isSegment = (link: string) => this.app.metadataCache.getFirstLinkpathDest(link, session.path) === file;
			await editNote(this.app, session, (text) => removeSegmentLines(text, file.path, isSegment));
			await this.app.fileManager.trashFile(file);
			new Notice(`${file.name}을(를) 삭제했습니다.`);
		} catch (e) {
			report("오디오 삭제 실패", e);
		} finally {
			this.setStatus("idle");
		}
	}

	/** Puts a session's summary into the note being edited. A block elsewhere stays there, and a session without one gets summarized. */
	async insertSession(session: TFile) {
		const id = sessionIdOf(this.app, session);
		if (!id) return void new Notice("Voice Context 세션 노트가 아닙니다.");
		if (this.status !== "idle") return void new Notice("녹음이나 정리가 끝난 뒤에 실행하세요.");
		const view = this.workingView();
		const note = view?.file;
		if (!view || !note) return void new Notice("정리를 넣을 노트를 먼저 여세요.");
		if (note === session) return void new Notice("세션 노트에는 넣을 수 없습니다. 정리를 넣을 노트를 여세요.");
		this.setStatus("processing", "현재 노트에 넣는 중…");
		let marked = false;
		try {
			if (findBlock(await readNote(this.app, note), id)) return void new Notice(`이미 '${note.basename}'에 있습니다.`);
			const text = await readNote(this.app, session);
			const transcript = transcriptOf(text);
			const found = await this.locate(session, id, null);
			const source = found?.kind === "block" ? await readNote(this.app, found.file) : "";
			const block = findBlock(source, id);
			if (!block && !transcript) return void new Notice("세션에 정리도 받아쓴 내용도 없습니다.");
			await this.insertPending(view, id);
			marked = true;
			if (block) {
				const callout = renderCallout(this.app.metadataCache.fileToLinktext(session, note.path, true), durationMinutes(text));
				const rendered = renderBlock(id, source.slice(block.bodyFrom, block.bodyTo), callout);
				await editNote(this.app, note, (t) => {
					const pending = findPending(t, id);
					return pending ? t.slice(0, pending.from) + rendered + t.slice(pending.to) : t;
				});
				await addNoteLink(this.app, session, note);
				new Notice(`정리를 '${note.basename}'에 넣었습니다.`);
			} else {
				this.setStage("정리 중…");
				const written = await this.writeBlock(session, id, { file: note, kind: "pending" }, transcript, await this.context(session, text), durationMinutes(text));
				if (written) new Notice(`정리를 '${note.basename}'에 넣었습니다.`);
			}
		} catch (e) {
			if (marked) await this.removePending({ target: note, id });
			if (e instanceof Cancelled) new Notice("취소했습니다.");
			else report("현재 노트에 넣기 실패", e);
		} finally {
			this.setStatus("idle");
		}
	}

	/** Summarizes audio or a transcript note made elsewhere, such as by Quick Capture or the core Audio recorder. */
	async importExisting(source: TFile) {
		if (this.status !== "idle") return void new Notice("녹음이나 정리가 끝난 뒤에 실행하세요.");
		const isNote = source.extension === "md";
		const problem = isNote ? null : this.plugin.transcriptionProblem();
		if (problem) return void new Notice(problem);
		const limitMb = MAX_UPLOAD_MB[this.settings.transcriptionProvider];
		if (!isNote && source.stat.size > limitMb * 1024 * 1024) return void new Notice(`${source.name}은(는) 받아쓰기 API 한도인 ${limitMb}MB를 넘습니다.`, 10_000);
		if (isNote && source.stat.size > LARGE_NOTE_BYTES) {
			const message = `${source.name}은(는) ${Math.round(source.stat.size / 1024)}KB입니다. 전체를 정리 모델로 보냅니다. 계속할까요?`;
			if (!(await confirmModal(this.app, message, "계속"))) return;
		}
		const earlier = await importedSession(this.app, this.settings.recordingsFolder, source);
		if (earlier && !(await confirmModal(this.app, `${source.name}은(는) 이미 '${earlier.basename}'로 가져왔습니다. 새 세션을 또 만들까요?`, "새로 만들기"))) return;
		// Another command can start a job while a modal is open.
		if (this.status !== "idle") return void new Notice("녹음이나 정리가 끝난 뒤에 실행하세요.");
		this.setStatus("processing", isNote ? "정리 중…" : "받아쓰는 중…");
		let outcome: Outcome | null = null;
		try {
			// Read before the pending marker goes in, because the source may be the working note.
			const noteText = isNote ? transcriptFromNote(await readNote(this.app, source)) : "";
			if (isNote && !noteText) return void new Notice("노트에 정리할 내용이 없습니다.");

			const view = this.workingView();
			const note = view?.file ?? null;
			const editor = liveEditor(view);
			const selection = editor?.somethingSelected() ? stripMarkers(editor.getSelection()) : "";
			const now = new Date();
			const id = sessionId(now);
			this.abort.signal.throwIfAborted();
			const session = await createSession(this.app, this.settings.recordingsFolder, id, now, note, note ? "" : pendingMarker(id));
			if (view && note) await this.insertPending(view, id);
			const heading = importHeading(formatDateTime(now), this.app.metadataCache.fileToLinktext(source, session.path, true));
			await appendSection(this.app, session, SECTION.transcript, heading);
			if (selection && note) {
				const title = `${formatTime(now)} · 선택 영역 · [[${this.app.metadataCache.fileToLinktext(note, session.path, true)}]]`;
				await appendSection(this.app, session, SECTION.context, renderContextEntry(title, selection));
			}

			outcome = { session, id, isContinue: false, previousTranscript: "", heading, target: note ?? session, texts: [], failed: 0 };
			if (isNote) {
				outcome.texts.push(noteText);
			} else {
				await appendSection(this.app, session, SECTION.audio, `![[${source.path}]]`);
				try {
					const text = await this.transcribeAudio(await this.app.vault.readBinary(source), source.name, MIME_BY_EXT[source.extension] ?? "audio/webm", "");
					if (text) outcome.texts.push(text);
				} catch (e) {
					if (e instanceof Cancelled) throw e;
					outcome.failed++;
					await appendSection(this.app, session, SECTION.transcript, failedMarker(source.path));
					report(`${source.name} 받아쓰기 실패`, e, "", 10_000);
				}
			}
			if (outcome.texts[0]) await appendSection(this.app, session, SECTION.transcript, outcome.texts[0]);
			await this.finish(outcome);
		} catch (e) {
			if (!(e instanceof Cancelled)) {
				report("가져오기 실패", e);
			} else if (outcome?.texts.length) {
				await this.keepAfterCancel(outcome);
			} else {
				if (outcome) {
					await this.removePending(outcome);
					// Created seconds ago by this job and holds no transcript.
					await this.app.fileManager.trashFile(outcome.session);
				}
				new Notice("가져오기를 취소했습니다.");
			}
		} finally {
			this.setStatus("idle");
		}
	}

	dispose() {
		this.cancel();
		this.wakeLock.set(false);
		// Best effort on unload: flush the current segment to disk.
		if (this.run) void this.run.recorder.stop();
	}

	private enqueue(run: Run, task: () => Promise<void>): Promise<void> {
		run.queue = run.queue.then(task).catch((e) => {
			report("세션 노트 기록 실패", e);
		});
		return run.queue;
	}

	private async drain(run: Run) {
		let queue: Promise<void>;
		do {
			queue = run.queue;
			await queue;
		} while (queue !== run.queue);
	}

	private async insertPending(view: MarkdownView, id: string) {
		const editor = liveEditor(view);
		if (!editor) {
			await editNote(this.app, view.file!, (t) => `${t.trimEnd()}\n\n${pendingMarker(id)}\n`);
			return;
		}
		const from = editor.getCursor("from");
		const to = editor.getCursor("to");
		let line = to.line;
		// A drag selection that ends at column 0 really ends on the previous line.
		if (editor.somethingSelected() && to.ch === 0 && to.line > from.line) line--;
		const current = editor.getLine(line);
		const next = line + 1 < editor.lineCount() ? editor.getLine(line + 1) : null;
		// Inserting after the selection end leaves the selection itself untouched.
		editor.replaceRange(`${current.trim() ? "\n\n" : "\n"}${pendingMarker(id)}${next?.trim() ? "\n" : ""}`, { line, ch: current.length });
	}

	private async processSegment(run: Run, segment: Segment) {
		try {
			// A stop right after a rotation leaves a near-empty tail segment.
			if (segment.durationMs < MIN_SEGMENT_MS || segment.blob.size < MIN_AUDIO_BYTES) return;
			const ext = segment.mimeType.includes("mp4") ? "m4a" : "webm";
			const data = await segment.blob.arrayBuffer();
			const file = await saveAudio(this.app, run.session, segment.index, ext, data);
			await appendSection(this.app, run.session, SECTION.audio, `![[${file.path}]]`);
			const prompt = `${run.previousTranscript}\n${run.texts.join("\n")}`.trim().slice(-PROMPT_TAIL_CHARS);
			try {
				const text = await this.transcribeAudio(data, file.name, segment.mimeType, prompt);
				if (!text) return;
				run.texts.push(text);
				await appendSection(this.app, run.session, SECTION.transcript, text);
			} catch (e) {
				run.failed++;
				await appendSection(this.app, run.session, SECTION.transcript, failedMarker(file.path));
				if (!(e instanceof Cancelled)) report(`녹음 조각 ${padIndex(segment.index)} 받아쓰기 실패`, e, "오디오는 저장되었습니다.", 10_000);
			}
		} finally {
			run.pendingSegments--;
			this.emit();
		}
	}

	private async transcribeAudio(
		data: ArrayBuffer,
		fileName: string,
		mimeType: string,
		prompt: string,
		phrases = this.settings.phrasePresets.find((p) => p.name === this.settings.activePreset)?.phrases ?? [],
	) {
		const problem = this.plugin.transcriptionProblem();
		if (problem) throw new Error(problem);
		const languages = splitList(this.settings.transcriptionLanguages);
		if (this.settings.transcriptionProvider === "azure") {
			const { azureEndpoint, azureModel, azureTranscribeStyle } = this.settings;
			const audio = await maiAudio(data, fileName, mimeType);
			const { text, durationMs } = await withRetry(() => transcribeAzure(azureEndpoint, this.plugin.azureKey()!, azureModel, languages[0], azureTranscribeStyle, phrases, audio), this.abort.signal);
			if (durationMs) {
				const month = new Date().toISOString().slice(0, 7);
				const usage = this.settings.azureUsageMs;
				this.settings.azureUsageMs = { ...usage, [month]: (usage[month] ?? 0) + durationMs };
				void this.plugin.saveSettings();
			}
			return demoteHeadings(text);
		}
		const key = this.plugin.apiKey()!;
		const fields = transcriptionFields({ model: this.settings.transcriptionModel, prompt, languages });
		return demoteHeadings(await withRetry(() => transcribe(key, data, fileName, mimeType, fields), this.abort.signal));
	}

	private async finish(run: Outcome) {
		this.abort.signal.throwIfAborted();
		const text = await readNote(this.app, run.session);
		if (!run.texts.length) {
			if (run.failed) {
				new Notice(`받아쓰기 실패 ${run.failed}건. '실패한 녹음 조각 다시 받아쓰기' 후 '정리 다시 쓰기'를 실행하세요.`, 10_000);
			} else {
				new Notice("인식된 음성이 없습니다. 마이크 권한과 입력 장치를 확인하세요.", 10_000);
				await this.removePending(run);
				await editNote(this.app, run.session, (t) => {
					const r = findLine(t, run.heading);
					// Drop the run heading only if nothing was written under it.
					if (!r || !/^\s*(?:#|$)/.test(t.slice(r.to))) return t;
					return t.slice(0, r.from).replace(/\n+$/, "\n") + t.slice(r.to).replace(/^\n+/, "\n");
				});
			}
			return;
		}
		const context = await this.context(run.session, text);
		const minutes = durationMinutes(text);
		const found = await this.locate(run.session, run.id, run.target);
		if (run.isContinue && found?.kind === "block") await this.updateBlock(run, found.file, context, minutes);
		else {
			const file = await this.writeBlock(run.session, run.id, found, transcriptOf(text), context, minutes);
			if (file) new Notice(`정리를 '${file.basename}'에 넣었습니다.`);
		}
	}

	private async context(session: TFile, sessionText: string) {
		this.setStage("참고 자료 읽는 중…");
		const entries = parseContextEntries(extractSection(sessionText, SECTION.context));
		return cancellable(expandContext(this.app, entries, session.path, this.settings), this.abort.signal);
	}

	/** `summarizing` false sends only `rules`, for a judgment that writes no summary. */
	private async llm(rules: string, input: string, summarizing = true): Promise<string> {
		if (summarizing) this.setStage("정리 중…");
		const instructions = summarizing ? `${this.settings.summaryPrompt.trim()}\n\n${FORMAT_RULES}\n\n${rules}` : rules;
		const token = await cancellable(this.plugin.summaryToken(), this.abort.signal);
		return withRetry(() => generate(token, this.settings.summaryModel, instructions, input), this.abort.signal);
	}

	/** Block first, then a pending marker: the working note, the notes in `notes`, the session itself. */
	private async locate(session: TFile, id: string, preferred: TFile | null): Promise<Location | null> {
		const seen = new Set<string>();
		let pending: Location | null = null;
		for (const file of [preferred, ...linkedNotes(this.app, session), session]) {
			if (!file || seen.has(file.path)) continue;
			seen.add(file.path);
			const text = await readNote(this.app, file);
			if (findBlock(text, id)) return { file, kind: "block" };
			if (!pending && findPending(text, id)) pending = { file, kind: "pending" };
		}
		return pending;
	}

	/** Returns the file that received the summary, or null when summarizing failed, even if a warning block was written. */
	private async writeBlock(session: TFile, id: string, found: Location | null, transcript: string, context: string, minutes: number): Promise<TFile | null> {
		const heading = `### 정리 · ${formatDateTime(dateFromSessionId(id) ?? new Date())}`;
		let body: string;
		let summarized = true;
		try {
			body = `${heading}\n${unfence(await this.llm(CREATE_RULES, joinTags(tag("transcript", transcript), tag("context", context))))}`;
		} catch (e) {
			if (e instanceof Cancelled) throw e;
			report("정리 실패", e, "받아쓴 글은 세션 노트에 보존되었습니다.", 10_000);
			if (found?.kind === "block") return null;
			summarized = false;
			body = `${heading}\n> [!warning] 정리 실패\n> ${explainError(e)}\n> 받아쓴 글은 세션 노트에 있습니다. '정리 다시 쓰기'로 다시 시도하세요.`;
		}
		const render = (file: TFile) =>
			renderBlock(id, body, file === session ? null : renderCallout(this.app.metadataCache.fileToLinktext(session, file.path, true), minutes));

		if (found) {
			await editNote(this.app, found.file, (t) => {
				const block = findBlock(t, id);
				if (block) return t.slice(0, block.from) + render(found.file) + t.slice(block.to);
				const pending = findPending(t, id);
				if (pending) return t.slice(0, pending.from) + render(found.file) + t.slice(pending.to);
				return `${t.trimEnd()}\n\n${render(found.file)}\n`;
			});
			if (found.file !== session) await addNoteLink(this.app, session, found.file);
			return summarized ? found.file : null;
		}
		// The marker was deleted: put the block at the cursor of the note being edited.
		const view = this.workingView();
		const editor = liveEditor(view);
		if (view?.file && editor) {
			const line = editor.getCursor().line;
			editor.replaceRange(`\n\n${render(view.file)}\n`, { line, ch: editor.getLine(line).length });
			if (view.file !== session) await addNoteLink(this.app, session, view.file);
			return summarized ? view.file : null;
		}
		await editNote(this.app, session, (t) => `${t.trimEnd()}\n\n${render(session)}\n`);
		return summarized ? session : null;
	}

	/** Continue mode: insert new lines into the existing summary and never rewrite the user's lines. */
	private async updateBlock(run: Outcome, file: TFile, context: string, minutes: number) {
		const current = await readNote(this.app, file);
		const block = findBlock(current, run.id)!;
		const body = current.slice(block.bodyFrom, block.bodyTo).trimEnd();
		let insertions: Insertion[] = [];
		let failed = false;
		try {
			const output = await this.llm(
				UPDATE_RULES,
				joinTags(
					tag("current_summary", numberLines(body)),
					tag("previous_transcript", run.previousTranscript),
					tag("new_transcript", run.texts.join("\n\n")),
					tag("context", context),
				),
			);
			insertions = parseInsertions(output);
		} catch (e) {
			if (e instanceof Cancelled) throw e;
			failed = true;
			report("정리 갱신 실패", e, "받아쓴 글은 보존되었습니다. '정리 다시 쓰기'로 다시 정리할 수 있습니다.", 10_000);
		}
		const callout = renderCallout(this.app.metadataCache.fileToLinktext(run.session, file.path, true), minutes);
		await editNote(this.app, file, (t) => {
			const b = findBlock(t, run.id);
			if (!b) return t;
			// Apply to the latest body so edits made while the model was running survive.
			const latest = t.slice(b.bodyFrom, b.bodyTo).trimEnd();
			return t.slice(0, b.from) + renderBlock(run.id, applyInsertions(latest, insertions), callout) + t.slice(b.to);
		});
		if (!failed) new Notice(insertions.length ? `'${file.basename}' 정리에 ${insertions.length}곳을 추가했습니다.` : "정리에 추가할 내용이 없었습니다.");
	}

	/** A cancelled job that has a transcript: the session stays and can be summarized later. */
	private async keepAfterCancel(run: Outcome) {
		const retry = run.failed ? " 받아쓰지 못한 녹음 조각은 먼저 '실패한 녹음 조각 다시 받아쓰기'를 실행하세요." : "";
		const kept = run.texts.length ? " 받아쓴 글은 세션 노트에 있으니 '정리 다시 쓰기'로 다시 정리할 수 있습니다." : "";
		new Notice(`취소했습니다.${kept}${retry}`, 10_000);
		await this.removePending(run);
	}

	private async removePending(run: Pick<Outcome, "target" | "id">) {
		if (!run.target) return;
		await editNote(this.app, run.target, (t) => {
			const r = findPending(t, run.id);
			if (!r) return t;
			let from = r.from;
			for (let i = 0; i < 2 && t[from - 1] === "\n"; i++) from--;
			return t.slice(0, from) + t.slice(r.to);
		});
	}
}
