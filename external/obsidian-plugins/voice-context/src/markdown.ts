// Pure text helpers. No `obsidian` import so the test runner can load this module.

const MARKER = "voice-context";
const CALLOUT_LABEL = "받아쓴 원문";

export const pendingMarker = (id: string) => `%% ${MARKER}:pending ${id} %%`;
export const startMarker = (id: string) => `%% ${MARKER}:start ${id} %%`;
export const END_MARKER = `%% ${MARKER}:end %%`;
export const failedMarker = (audioPath: string) => `%% ${MARKER}:failed ${audioPath} %%`;
export const FAILED_RE = /^%% voice-context:failed (.+?) %%$/gm;
export const EMBED_LINE_RE = /^!\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/;
const ANY_MARKER_RE = /^%% voice-context:[^\n]*%%[ \t]*$/gm;

export interface Range {
	from: number;
	to: number;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

export const sessionId = (d: Date) =>
	`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

export const formatDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const formatTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export const formatDateTime = (d: Date) => `${formatDate(d)} ${formatTime(d)}`;

export const formatLocalIso = (d: Date) => `${formatDate(d)}T${formatTime(d)}:${pad(d.getSeconds())}`;

export function formatClock(ms: number): string {
	const s = Math.floor(ms / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

export const padIndex = (n: number) => pad(n, 3);

export function sanitizeFileName(name: string): string {
	return name.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "녹음";
}

/** Range of a whole line equal to `line`, searching from `fromIndex`. `to` excludes the newline. */
export function findLine(text: string, line: string, fromIndex = 0): Range | null {
	let i = text.indexOf(line, fromIndex);
	while (i >= 0) {
		const to = i + line.length;
		if ((i === 0 || text[i - 1] === "\n") && (to === text.length || text[to] === "\n")) return { from: i, to };
		i = text.indexOf(line, i + 1);
	}
	return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Content range of a `## heading` section, up to the next `#`/`##` heading. */
export function findSection(text: string, heading: string): Range | null {
	const m = new RegExp(`^## ${escapeRe(heading)}[ \\t]*$`, "m").exec(text);
	if (!m) return null;
	let from = m.index + m[0].length;
	if (text[from] === "\n") from++;
	const next = /^#{1,2} /m.exec(text.slice(from));
	return { from, to: next ? from + next.index : text.length };
}

export function extractSection(text: string, heading: string): string {
	const r = findSection(text, heading);
	return r ? text.slice(r.from, r.to).trim() : "";
}

export function appendToSection(text: string, heading: string, chunk: string): string {
	const r = findSection(text, heading);
	if (!r) return `${text.trimEnd()}\n\n## ${heading}\n\n${chunk.trimEnd()}\n`;
	const before = text.slice(0, r.to).trimEnd();
	const after = text.slice(r.to);
	return `${before}\n\n${chunk.trimEnd()}\n${after ? `\n${after}` : ""}`;
}

/** Drops a deleted segment's failed marker and whole-line embeds, each with the blank line after it. */
export function removeSegmentLines(text: string, audioPath: string, isSegment: (link: string) => boolean): string {
	const marker = failedMarker(audioPath);
	const lines = text.split("\n");
	const kept: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const embed = EMBED_LINE_RE.exec(line);
		if (line !== marker && !(embed && isSegment(embed[1]!))) kept.push(line);
		else if (lines[i + 1] === "") i++;
	}
	return kept.join("\n");
}

export const quote = (text: string) =>
	text
		.split("\n")
		.map((l) => (l ? `> ${l}` : ">"))
		.join("\n");

export const stripMarkers = (text: string) => text.replace(ANY_MARKER_RE, "").replace(/\n{3,}/g, "\n\n").trim();

/** `findSection` ends a section at the next `#`/`##`, so text placed inside `## 받아쓰기` must not contain one. */
export const demoteHeadings = (text: string) => text.replace(/^#{1,2}(?=[ \t])/gm, "###$&");

/** A note's own text: no frontmatter, no summary blocks written by an earlier run, and no headings that would end a section. */
export const transcriptFromNote = (text: string) =>
	demoteHeadings(stripMarkers(text.replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/^%% voice-context:start [^\n]*%%$[\s\S]*?^%% voice-context:end %%$/gm, "")));

export const importMarker = (sourceLink: string) => ` · 가져오기 · [[${sourceLink}]]`;

export const importHeading = (date: string, sourceLink: string) => `### ${date}${importMarker(sourceLink)}`;

/** A complete model name is the saved value, not a search, so it lists everything. */
export function modelSuggestions(models: string[], query: string): string[] {
	const q = query.trim().toLowerCase();
	return models.some((m) => m.toLowerCase() === q) ? models : models.filter((m) => m.toLowerCase().includes(q));
}

export interface ContextEntry {
	title: string;
	body: string;
}

export const renderContextEntry = (title: string, body: string) => `### ${title}\n${quote(body)}`;

export function parseContextEntries(section: string): ContextEntry[] {
	const entries: ContextEntry[] = [];
	let current: { title: string; lines: string[] } | null = null;
	const flush = () => {
		if (!current) return;
		const body = current.lines.join("\n").trim();
		if (body) entries.push({ title: current.title, body });
	};
	for (const line of section.split("\n")) {
		if (line.startsWith("### ")) {
			flush();
			current = { title: line.slice(4).trim(), lines: [] };
		} else if (current) {
			current.lines.push(line.replace(/^> ?/, ""));
		}
	}
	flush();
	return entries;
}

export interface Links {
	internal: string[];
	urls: string[];
}

export function extractLinks(text: string): Links {
	const internal = new Set<string>();
	const urls = new Set<string>();
	for (const m of text.matchAll(/!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) internal.add(m[1]!.trim());
	for (const m of text.matchAll(/\[[^\]]*\]\((?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\)/g)) {
		const target = (m[1] ?? m[2])!.trim();
		if (/^https?:\/\//i.test(target)) urls.add(target);
		else if (!/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("#")) {
			try {
				internal.add(decodeURI(target));
			} catch {
				internal.add(target);
			}
		}
	}
	for (const m of text.matchAll(/(?<![(<\w])https?:\/\/[^\s<>)\]]+/g)) urls.add(m[0].replace(/[.,;:!?'"]+$/, ""));
	return { internal: [...internal], urls: [...urls] };
}

export interface Block extends Range {
	/** Start of the editable summary, right after the start marker line. */
	bodyFrom: number;
	/** End of the editable summary: the transcript callout or the end marker. */
	bodyTo: number;
}

export function findBlock(text: string, id: string): Block | null {
	const s = findLine(text, startMarker(id));
	if (!s) return null;
	const e = findLine(text, END_MARKER, s.to);
	if (!e) return null;
	const bodyFrom = Math.min(s.to + 1, e.from);
	const callout = new RegExp(`^> \\[!quote\\]-? ${CALLOUT_LABEL}`, "m").exec(text.slice(bodyFrom, e.from));
	return { from: s.from, to: e.to, bodyFrom, bodyTo: callout ? bodyFrom + callout.index : e.from };
}

export const findPending = (text: string, id: string) => findLine(text, pendingMarker(id));

/** Session id of the block or pending marker that contains `offset`. */
export function blockIdAt(text: string, offset: number): string | null {
	for (const m of text.matchAll(/^%% voice-context:(start|pending) (\S+) %%$/gm)) {
		const from = m.index;
		const to = m[1] === "start" ? (findBlock(text, m[2]!)?.to ?? from + m[0].length) : from + m[0].length;
		if (offset >= from && offset <= to) return m[2]!;
	}
	return null;
}

export const renderCallout = (sessionLink: string, minutes: number) =>
	`> [!quote]- ${CALLOUT_LABEL} · [[${sessionLink}|세션]]${minutes ? ` · ${minutes}분` : ""}\n> ![[${sessionLink}#받아쓰기]]`;

export const renderBlock = (id: string, body: string, callout: string | null) =>
	// Without the blank line the callout renders inside the body's last list item.
	[startMarker(id), body.trimEnd(), ...(callout ? ["", callout] : []), END_MARKER].join("\n");

export const numberLines = (body: string) =>
	body
		.split("\n")
		.map((l, i) => `${i + 1}| ${l}`)
		.join("\n");

export interface Insertion {
	afterLine: number;
	text: string;
}

export function parseInsertions(output: string): Insertion[] {
	const start = output.indexOf("{");
	const end = output.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error("정리 갱신 응답에서 JSON을 찾지 못했습니다");
	const data = JSON.parse(output.slice(start, end + 1)) as { insertions?: unknown };
	if (!Array.isArray(data.insertions)) throw new Error("정리 갱신 응답에 insertions 배열이 없습니다");
	const result: Insertion[] = [];
	for (const item of data.insertions as { after_line?: unknown; text?: unknown }[]) {
		const afterLine = Number(item?.after_line);
		if (!Number.isFinite(afterLine) || typeof item.text !== "string" || !item.text.trim()) continue;
		let lines = item.text.replace(/\s+$/, "").split("\n");
		// Models sometimes echo the `N| ` numbering back.
		if (lines.every((l) => /^\d+\| ?/.test(l))) lines = lines.map((l) => l.replace(/^\d+\| ?/, ""));
		result.push({ afterLine: Math.trunc(afterLine), text: lines.join("\n") });
	}
	return result;
}

const indentOf = (line: string) => /^[ \t]*/.exec(line)![0].replace(/\t/g, "    ").length;

/** Insert lines without touching existing ones. Same-anchor insertions keep their order. */
export function applyInsertions(body: string, insertions: Insertion[]): string {
	const lines = body.split("\n");
	const targets = insertions.map((ins, order) => {
		let at = Math.max(0, Math.min(lines.length, ins.afterLine));
		const inserted = ins.text.split("\n");
		if (at > 0) {
			const anchorIndent = indentOf(lines[at - 1]!);
			const first = inserted.find((l) => l.trim()) ?? "";
			// A sibling (not a child) goes after the anchor's nested children.
			if (indentOf(first) <= anchorIndent) {
				while (at < lines.length && lines[at]!.trim() && indentOf(lines[at]!) > anchorIndent) at++;
			}
		}
		return { at, order, inserted };
	});
	targets.sort((a, b) => b.at - a.at || b.order - a.order);
	for (const t of targets) lines.splice(t.at, 0, ...t.inserted);
	return lines.join("\n");
}

/** Smallest single replacement that turns `a` into `b`. */
export function diffRange(a: string, b: string): Range & { text: string } {
	const max = Math.min(a.length, b.length);
	let p = 0;
	while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
	let s = 0;
	while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
	return { from: p, to: a.length - s, text: b.slice(p, b.length - s) };
}

export function dateFromSessionId(id: string): Date | null {
	const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(id);
	return m ? new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : null;
}
