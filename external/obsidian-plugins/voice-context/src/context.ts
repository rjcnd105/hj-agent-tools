import { type App, type TFile, htmlToMarkdown, parseLinktext, requestUrl, resolveSubpath } from "obsidian";
import { type ContextEntry, extractLinks } from "./markdown";

export interface ContextOptions {
	includeExternalUrls: boolean;
	maxCharsPerSource: number;
	maxContextChars: number;
}

const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_CHARS = 2_000_000;
const NOISE = "script,style,noscript,template,nav,header,footer,aside,form,iframe,svg,canvas";

const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…(이하 생략)` : text);

/**
 * Turns the session's Context entries into prompt text, expanding the links inside each
 * entry one level deep: internal notes (with heading/block subpaths) and external pages.
 */
export async function expandContext(app: App, entries: ContextEntry[], sessionPath: string, opts: ContextOptions): Promise<string> {
	const seen = new Set<string>();
	const jobs: Promise<string | null>[] = [];
	for (const entry of entries) {
		// Links in the entry body resolve relative to the note the selection came from.
		const sourceLink = /\[\[([^\]|]+)/.exec(entry.title)?.[1];
		const source = (sourceLink && app.metadataCache.getFirstLinkpathDest(sourceLink, sessionPath)?.path) || sessionPath;
		const { internal, urls } = extractLinks(entry.body);
		for (const link of internal) {
			const { path, subpath } = parseLinktext(link);
			const file = app.metadataCache.getFirstLinkpathDest(path, source);
			if (!file || file.extension !== "md" || seen.has(file.path + subpath)) continue;
			seen.add(file.path + subpath);
			jobs.push(readLinkedNote(app, file, subpath, opts.maxCharsPerSource));
		}
		if (!opts.includeExternalUrls) continue;
		for (const url of urls) {
			if (seen.has(url)) continue;
			seen.add(url);
			jobs.push(fetchPage(url, opts.maxCharsPerSource));
		}
	}
	const linked = (await Promise.all(jobs)).filter((s): s is string => !!s);

	let budget = opts.maxContextChars;
	const parts: string[] = [];
	const push = (s: string) => {
		if (budget <= 0) return;
		const piece = cap(s, budget);
		parts.push(piece);
		budget -= piece.length;
	};
	if (entries.length) push("## 사용자가 제공한 맥락");
	for (const e of entries) push(`### ${e.title}\n${cap(e.body, opts.maxCharsPerSource)}`);
	if (linked.length) push("## 링크된 자료");
	linked.forEach(push);
	return parts.join("\n\n");
}

async function readLinkedNote(app: App, file: TFile, subpath: string, max: number): Promise<string | null> {
	const text = await app.vault.cachedRead(file);
	const cache = app.metadataCache.getFileCache(file);
	let body = text;
	const sub = subpath && cache ? resolveSubpath(cache, subpath) : null;
	if (sub) body = text.slice(sub.start.offset, sub.end?.offset ?? text.length);
	else if (cache?.frontmatterPosition) body = text.slice(cache.frontmatterPosition.end.offset);
	body = body.trim();
	return body ? `### [[${file.basename}${sub ? subpath : ""}]]\n${cap(body, max)}` : null;
}

async function fetchPage(url: string, max: number): Promise<string> {
	try {
		const res = await Promise.race([
			requestUrl({ url, throw: false }),
			new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("timeout")), FETCH_TIMEOUT_MS)),
		]);
		if (res.status >= 400) return `### ${url}\n(가져오기 실패: HTTP ${res.status})`;
		const type = (Object.entries(res.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "").toLowerCase();
		let title = url;
		let body: string;
		if (type.includes("html")) {
			const doc = new DOMParser().parseFromString(res.text.slice(0, MAX_HTML_CHARS), "text/html");
			title = doc.title.trim() ? `${doc.title.trim()} (${url})` : url;
			for (const el of Array.from(doc.querySelectorAll(NOISE))) el.remove();
			body = htmlToMarkdown(doc.querySelector("article") ?? doc.querySelector("main") ?? doc.body);
		} else if (!type || type.startsWith("text/") || type.includes("json") || type.includes("xml")) {
			body = res.text;
		} else {
			return `### ${url}\n(텍스트가 아닌 자료: ${type})`;
		}
		return `### ${title}\n${cap(body.replace(/\n{3,}/g, "\n\n").trim(), max)}`;
	} catch (e) {
		return `### ${url}\n(가져오기 실패: ${e instanceof Error ? e.message : String(e)})`;
	}
}
