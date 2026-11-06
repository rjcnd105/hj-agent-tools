import { MarkdownView, getLinkpath, normalizePath, setIcon } from "obsidian";
import type VoiceContextPlugin from "./main";
import { audioFolder, sessionIdOf } from "./session";

const BUTTON_CLASS = "vc-segment-delete";
// `:has` lets a re-rendered embed pick its button up again.
const UNDECORATED = `.internal-embed.media-embed[src]:not(:has(> .${BUTTON_CLASS}))`;

const swallow = (e: Event) => {
	e.preventDefault();
	// Live Preview would otherwise reveal the embed's source under the click.
	e.stopPropagation();
};

/**
 * Adds a delete button to each segment embed of an open session note. Only files in the session's own
 * audio folder qualify, because imported sessions embed the user's original audio from elsewhere.
 */
export function registerSegmentActions(plugin: VoiceContextPlugin) {
	const { app } = plugin;
	const observers = new Map<MarkdownView, MutationObserver>();

	const decorate = (view: MarkdownView) => {
		const session = view.file;
		if (!session || sessionIdOf(app, session) === null || session.parent?.path !== normalizePath(plugin.settings.recordingsFolder)) return;
		const folder = audioFolder(session);
		for (const embed of view.contentEl.querySelectorAll<HTMLElement>(UNDECORATED)) {
			const file = app.metadataCache.getFirstLinkpathDest(getLinkpath(embed.getAttribute("src") ?? ""), session.path);
			if (file?.parent?.path !== folder) continue;
			const button = embed.createEl("button", { cls: [BUTTON_CLASS, "clickable-icon"], attr: { type: "button", "aria-label": `${file.name} 삭제` } });
			setIcon(button, "trash-2");
			button.addEventListener("mousedown", swallow);
			button.addEventListener("click", (e) => {
				swallow(e);
				void plugin.controller.deleteSegment(session, file);
			});
		}
	};

	const watch = (view: MarkdownView) => {
		if (observers.has(view)) return;
		const observer = new MutationObserver(() => decorate(view));
		observer.observe(view.contentEl, { childList: true, subtree: true });
		observers.set(view, observer);
		view.register(() => {
			observer.disconnect();
			observers.delete(view);
		});
	};

	const refresh = () =>
		app.workspace.iterateAllLeaves((leaf) => {
			if (!(leaf.view instanceof MarkdownView)) return;
			watch(leaf.view);
			decorate(leaf.view);
		});

	plugin.registerEvent(app.workspace.on("layout-change", refresh));
	plugin.registerEvent(app.workspace.on("file-open", refresh));
	app.workspace.onLayoutReady(refresh);
	plugin.register(() => {
		for (const [view, observer] of observers) {
			observer.disconnect();
			for (const button of view.contentEl.querySelectorAll(`.${BUTTON_CLASS}`)) button.remove();
		}
		observers.clear();
	});
}
