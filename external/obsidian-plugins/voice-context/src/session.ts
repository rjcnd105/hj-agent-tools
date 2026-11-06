import { type App, TFile, normalizePath, stringifyYaml } from "obsidian";
import { EMBED_LINE_RE, appendToSection, extractSection, formatDate, formatLocalIso, formatTime, importMarker, padIndex, sanitizeFileName } from "./markdown";
import { editNote, parseFrontmatter, updateFrontmatter } from "./notes";

export const SESSION_KEY = "voice-context";
export const SECTION = { context: "Context", transcript: "받아쓰기", audio: "오디오", previousTranscript: "이전 받아쓰기" } as const;

export const sessionIdOf = (app: App, file: TFile): string | null => {
	const id: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.[SESSION_KEY];
	return id == null ? null : String(id);
};

export function listSessions(app: App, folder: string): TFile[] {
	const dir = app.vault.getFolderByPath(normalizePath(folder));
	if (!dir) return [];
	const sessions = dir.children.filter((f): f is TFile => f instanceof TFile && f.extension === "md" && sessionIdOf(app, f) !== null);
	// Ids are YYYYMMDD-HHmmss, so string order is chronological.
	return sessions.sort((a, b) => sessionIdOf(app, b)!.localeCompare(sessionIdOf(app, a)!));
}

export const findSession = (app: App, folder: string, id: string) => listSessions(app, folder).find((f) => sessionIdOf(app, f) === id) ?? null;

export async function createSession(app: App, folder: string, id: string, date: Date, note: TFile | null, preamble: string): Promise<TFile> {
	const dir = normalizePath(folder);
	if (!app.vault.getFolderByPath(dir)) await app.vault.createFolder(dir);
	const base = `${formatDate(date)} ${formatTime(date).replace(":", "")} ${sanitizeFileName(note?.basename ?? "녹음")}`;
	let path = `${dir}/${base}.md`;
	for (let n = 2; app.vault.getAbstractFileByPath(path); n++) path = `${dir}/${base} ${n}.md`;
	const fm = {
		[SESSION_KEY]: id,
		created: formatLocalIso(date),
		duration: 0,
		notes: note ? [`[[${app.metadataCache.fileToLinktext(note, path, true)}]]`] : [],
	};
	const body = [preamble, `## ${SECTION.context}`, `## ${SECTION.transcript}`, `## ${SECTION.audio}`].filter(Boolean).join("\n\n");
	return app.vault.create(path, `---\n${stringifyYaml(fm)}---\n\n${body}\n`);
}

export const appendSection = (app: App, session: TFile, heading: string, chunk: string) =>
	editNote(app, session, (text) => appendToSection(text, heading, chunk));

export const audioFolder = (session: TFile) => normalizePath(`${session.parent?.path ?? ""}/${session.basename}`);

export function nextSegmentIndex(app: App, session: TFile): number {
	const dir = app.vault.getFolderByPath(audioFolder(session));
	let max = 0;
	for (const f of dir?.children ?? []) max = Math.max(max, Number.parseInt(f.name, 10) || 0);
	return max + 1;
}

export async function saveAudio(app: App, session: TFile, index: number, ext: string, data: ArrayBuffer): Promise<TFile> {
	const dir = audioFolder(session);
	if (!app.vault.getFolderByPath(dir)) await app.vault.createFolder(dir);
	return app.vault.createBinary(`${dir}/${padIndex(index)}.${ext}`, data);
}

/** Notes that hold (or held) this session's summary block, from the `notes` property. */
export function linkedNotes(app: App, session: TFile): TFile[] {
	const links = app.metadataCache.getFileCache(session)?.frontmatterLinks ?? [];
	return links.map((l) => app.metadataCache.getFirstLinkpathDest(l.link, session.path)).filter((f): f is TFile => !!f);
}

export const addNoteLink = (app: App, session: TFile, note: TFile) =>
	updateFrontmatter(app, session, (fm) => {
		const link = `[[${app.metadataCache.fileToLinktext(note, session.path, true)}]]`;
		const notes = Array.isArray(fm.notes) ? (fm.notes as unknown[]) : [];
		if (!notes.includes(link)) fm.notes = [...notes, link];
	});

export const addDuration = (app: App, session: TFile, ms: number) =>
	updateFrontmatter(app, session, (fm) => {
		fm.duration = Math.round((Number(fm.duration) || 0) + ms / 1000);
	});

/** 0 means unknown: imported sessions never record a duration. */
export const durationMinutes = (sessionText: string) => {
	const seconds = Number(parseFrontmatter(sessionText).duration) || 0;
	return seconds ? Math.max(1, Math.round(seconds / 60)) : 0;
};

/** Formats the transcription API accepts that Obsidian also treats as audio. */
const IMPORTABLE_AUDIO = new Set(["m4a", "mp3", "wav", "webm"]);

/** Audio, then notes, that can be summarized as a new session, each group newest first. A session's own files are excluded. */
export function listImportable(app: App): TFile[] {
	const ownedBySession = (file: TFile) => {
		const session = app.vault.getFileByPath(`${file.parent?.path}.md`);
		return !!session && sessionIdOf(app, session) !== null;
	};
	return app.vault
		.getFiles()
		.filter((f) => (f.extension === "md" ? sessionIdOf(app, f) === null : IMPORTABLE_AUDIO.has(f.extension) && !ownedBySession(f)))
		.sort((a, b) => Number(a.extension === "md") - Number(b.extension === "md") || b.stat.mtime - a.stat.mtime);
}

/** Audio embedded in the session's audio section, in recording order. */
export const sessionAudio = (app: App, session: TFile, sessionText: string): TFile[] =>
	extractSection(sessionText, SECTION.audio)
		.split("\n")
		.flatMap((line) => {
			const link = EMBED_LINE_RE.exec(line.trim())?.[1];
			const file = link ? app.metadataCache.getFirstLinkpathDest(link, session.path) : null;
			return file && IMPORTABLE_AUDIO.has(file.extension) ? [file] : [];
		});

/** Newest session that was already imported from `source`. */
export async function importedSession(app: App, folder: string, source: TFile): Promise<TFile | null> {
	for (const session of listSessions(app, folder)) {
		if (!app.metadataCache.resolvedLinks[session.path]?.[source.path]) continue;
		const text = await app.vault.cachedRead(session);
		if (text.includes(importMarker(app.metadataCache.fileToLinktext(source, session.path, true)))) return session;
	}
	return null;
}
