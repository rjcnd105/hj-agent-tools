import { type App, MarkdownView, type TFile, parseYaml, stringifyYaml } from "obsidian";
import { diffRange } from "./markdown";

function sourceEditor(app: App, file: TFile) {
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view;
		if (view instanceof MarkdownView && view.file?.path === file.path && view.getMode() === "source") return view.editor;
	}
	return null;
}

/** Current text, including unsaved edits in an open editor. */
export async function readNote(app: App, file: TFile): Promise<string> {
	return sourceEditor(app, file)?.getValue() ?? app.vault.read(file);
}

/**
 * Edit a note without clobbering concurrent typing: an open editor gets the smallest
 * replacement (cursor and undo history survive), a closed note goes through `vault.process`.
 */
export async function editNote(app: App, file: TFile, edit: (text: string) => string): Promise<void> {
	const editor = sourceEditor(app, file);
	if (!editor) {
		await app.vault.process(file, edit);
		return;
	}
	const old = editor.getValue();
	const next = edit(old);
	if (next === old) return;
	const d = diffRange(old, next);
	editor.replaceRange(d.text, editor.offsetToPos(d.from), editor.offsetToPos(d.to));
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

/** Frontmatter parsed from text, so callers see edits the metadata cache has not indexed yet. */
export function parseFrontmatter(text: string): Record<string, unknown> {
	const m = FRONTMATTER_RE.exec(text);
	return ((m ? parseYaml(m[1]!) : null) ?? {}) as Record<string, unknown>;
}

/** Frontmatter edit routed through `editNote`, so it never races an open editor's pending save. */
export function updateFrontmatter(app: App, file: TFile, fn: (fm: Record<string, unknown>) => void): Promise<void> {
	return editNote(app, file, (text) => {
		const m = FRONTMATTER_RE.exec(text);
		const fm = parseFrontmatter(text);
		fn(fm);
		return `---\n${stringifyYaml(fm)}---\n${m ? text.slice(m[0].length) : `\n${text}`}`;
	});
}
