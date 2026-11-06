(async () => {
	const report = { done: false, results: [], error: null };
	window.__vcE2E = report;
	const plugin = app.plugins.plugins["voice-context"];
	const c = plugin.controller;
	const ROOT = "_vc-e2e";
	const RECORDINGS = `${ROOT}/Recordings`;

	const check = (name, ok, detail) => report.results.push({ name, ok: !!ok, detail: ok ? undefined : String(detail ?? "").slice(0, 400) });
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const until = async (fn, what, ms = 8000) => {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			const v = await fn();
			if (v) return v;
			await sleep(50);
		}
		throw new Error(`timed out waiting for ${what}`);
	};
	// Session ids have one-second resolution.
	const nextSecond = () => sleep(1100);
	const hang = () =>
		new Promise((_, reject) => {
			const { signal } = c.abort;
			if (signal.aborted) reject(signal.reason);
			signal.addEventListener("abort", () => reject(signal.reason));
		});

	const dataPath = `${app.vault.configDir}/plugins/voice-context/data.json`;
	const dataBefore = await app.vault.adapter.read(dataPath);
	const keyBefore = plugin.apiKey();
	const folderBefore = plugin.settings.recordingsFolder;
	const azureBefore = {
		transcriptionProvider: plugin.settings.transcriptionProvider,
		azureEndpoint: plugin.settings.azureEndpoint,
		azureModel: plugin.settings.azureModel,
		azureSecret: plugin.settings.azureSecret,
		azureTranscribeStyle: plugin.settings.azureTranscribeStyle,
		azureUsageMs: plugin.settings.azureUsageMs,
		phrasePresets: plugin.settings.phrasePresets,
		activePreset: plugin.settings.activePreset,
	};
	const azureKeyBefore = plugin.azureKey();
	const shown = (el) => el.offsetParent !== null;
	plugin.settings.transcriptionProvider = "openai";
	const activeBefore = app.workspace.getActiveFile()?.path;
	const panelBefore = app.workspace.getLeavesOfType("voice-context-recorder").length;
	const realGetUserMedia = navigator.mediaDevices.getUserMedia;
	const realSummaryToken = plugin.summaryToken;

	const noticeNodes = [];
	const observer = new MutationObserver((ms) => {
		for (const m of ms)
			for (const n of m.addedNodes) {
				if (n.classList?.contains("notice")) noticeNodes.push(n);
				else for (const x of n.querySelectorAll?.(".notice") ?? []) noticeNodes.push(x);
			}
	});
	observer.observe(document.body, { childList: true, subtree: true });
	const notices = () => noticeNodes.map((n) => n.textContent);
	const noticed = (text) => notices().some((t) => t.includes(text));
	const clearNotices = () => (noticeNodes.length = 0);

	// The link resolver pauses on activeWindow timers, and activeWindow stays on a closed popout while Obsidian is unfocused. Either one stops the resolver until the app reloads.
	const closeSettings = async () => {
		await until(() => app.metadataCache.isCacheClean(), "link resolver idle").catch(() => null);
		app.setting.close();
		await sleep(300);
		window.activeWindow = window;
	};

	// Obsidian's link resolver is a detached async loop: one throw stops it until the app reloads.
	const rejections = [];
	const onRejection = (e) => rejections.push(String(e.reason?.stack ?? e.reason));
	window.addEventListener("unhandledrejection", onRejection);

	const logged = [];
	const realConsoleError = console.error;
	console.error = (...args) => {
		logged.push(args.map(String).join(" "));
		realConsoleError.apply(console, args);
	};

	const llmCalls = [];
	const summary = "#### 핵심 내용\n- 항목 하나\n- 항목 둘";
	const stubLlm = (impl) => {
		c.llm = async (rules, input) => {
			llmCalls.push({ rules, input });
			c.setStage("정리 중…");
			return impl ? impl(rules, input) : rules.includes("insertions") ? '{"insertions":[{"after_line":2,"text":"- 이어서 추가"}]}' : summary;
		};
	};

	const sessions = () => (app.vault.getFolderByPath(RECORDINGS)?.children ?? []).filter((f) => f.extension === "md");
	const newestSession = () => sessions().sort((a, b) => b.stat.ctime - a.stat.ctime || b.path.localeCompare(a.path))[0];
	const modal = () => [...document.querySelectorAll(".modal-container .modal")].pop();
	const clickModal = async (label) => {
		const m = await until(modal, "confirm modal");
		const text = m.textContent;
		[...m.querySelectorAll("button")].find((b) => b.textContent === label).click();
		return text;
	};
	const leafOf = (leaf) => leaf.view;
	let leaf;
	let work;
	const read = (f) => app.vault.adapter.read(f.path);
	const flush = async () => {
		await leaf?.view?.save?.();
		await sleep(50);
	};
	const newWorkNote = async (name, body = "작업 노트 본문\n") => {
		work = await app.vault.create(`${ROOT}/${name}.md`, body);
		await until(() => app.metadataCache.getFileCache(work), "index");
		await leaf.openFile(work, { state: { mode: "source", source: false } });
		app.workspace.setActiveLeaf(leaf, { focus: false });
		await sleep(150);
	};
	const noteText = () => leaf.view.editor.getValue();
	const readNote = () => (leaf.view.getMode() === "source" ? noteText() : read(work));
	const wav = (seconds = 1) => {
		const rate = 16000;
		const n = rate * seconds;
		const buf = new ArrayBuffer(44 + n * 2);
		const v = new DataView(buf);
		const s = (o, t) => [...t].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
		s(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); s(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
		v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, "data"); v.setUint32(40, n * 2, true);
		for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin((i / rate) * 2 * Math.PI * 220) * 8000, true);
		return buf;
	};

	const trashBefore = new Set((await app.vault.adapter.list(".trash").catch(() => ({ files: [] }))).files);
	let ownsRoot = false;
	try {
		// iCloud can bring back the empty folders of a deleted run.
		const hasFiles = (f) => f.children.some((x) => !x.children || hasFiles(x));
		const leftover = app.vault.getAbstractFileByPath(ROOT);
		if (leftover && hasFiles(leftover)) throw new Error(`${ROOT} already exists`);
		if (leftover) await app.vault.delete(leftover, true);
		await app.vault.createFolder(ROOT);
		ownsRoot = true;
		plugin.settings.recordingsFolder = RECORDINGS;
		leaf = app.workspace.getLeaf("tab");

		// Note import keeps everything after a heading, and the callout stays outside the list.
		stubLlm();
		await newWorkNote("작업1");
		const source = await app.vault.create(`${ROOT}/원본.md`, "---\ntags: [a]\n---\n앞부분 메모\n\n## 안건\n내용A\n\n# 결론\n내용B\n");
		await until(() => app.metadataCache.getFileCache(source), "index");
		await c.importExisting(source);
		const s1 = newestSession();
		const s1Text = await read(s1);
		check("note import keeps text after headings in the session", ["앞부분 메모", "내용A", "내용B"].every((t) => s1Text.includes(t)), s1Text);
		check("note import sends the whole note to the summary", llmCalls.at(-1)?.input.includes("내용B"), llmCalls.at(-1)?.input);
		check("session sections survive demoted headings", /## 받아쓰기[\s\S]*내용B[\s\S]*## 오디오/.test(s1Text), s1Text);
		check("block has a blank line before the callout", /- 항목 둘\n\n> \[!quote\]-/.test(noteText()), noteText());
		check("pending marker is gone", !noteText().includes("voice-context:pending"), noteText());
		check("completion notice names the note", noticed("정리를 '작업1'에 넣었습니다"), notices().join(" | "));
		await leaf.setViewState({ type: "markdown", state: { file: work.path, mode: "preview" }, active: true });
		app.workspace.setActiveLeaf(leaf, { focus: false });
		await flush();
		await sleep(300);
		leaf.view.previewMode.rerender(true);
		const root = await until(() => leaf.view.contentEl.querySelector(".markdown-preview-sizer:has(.callout)"), "rendered callout");
		check("reading view renders the callout outside the list", root.querySelectorAll("li .callout").length === 0 && root.querySelectorAll(".callout").length === 1, root.innerHTML);
		await leaf.setViewState({ type: "markdown", state: { file: work.path, mode: "source", source: false }, active: true });

		// Import guards.
		await nextSecond();
		await until(() => app.metadataCache.resolvedLinks[s1.path]?.[source.path], "session link indexed");
		let count = sessions().length;
		let run = c.importExisting(source);
		const dupText = await clickModal("취소");
		await run;
		check("re-import asks first and declining adds nothing", dupText.includes("이미") && sessions().length === count, dupText);
		run = c.importExisting(source);
		await clickModal("새로 만들기");
		await run;
		check("re-import can still create a new session", sessions().length === count + 1, sessions().length);

		const large = await app.vault.create(`${ROOT}/큰 노트.md`, "가나다라\n".repeat(13_000));
		await until(() => app.metadataCache.getFileCache(large), "index");
		await nextSecond();
		count = sessions().length;
		run = c.importExisting(large);
		const largeText = await clickModal("취소");
		await run;
		check("large note asks first and declining adds nothing", largeText.includes("KB") && sessions().length === count && c.status === "idle", largeText);

		// Picker order.
		const audio = await app.vault.createBinary(`${ROOT}/원본 오디오.wav`, wav());
		plugin.pickImport();
		const items = await until(() => {
			const list = [...document.querySelectorAll(".modal-container .suggestion-item")].map((e) => e.textContent);
			return list.length ? list : null;
		}, "picker items");
		const firstNote = items.findIndex((t) => /\.md$/.test(t));
		const lastAudio = items.findLastIndex((t) => /\.(m4a|mp3|wav|webm)$/.test(t));
		check("picker lists audio before notes", /\.(m4a|mp3|wav|webm)$/.test(items[0]) && (firstNote < 0 || lastAudio < firstNote), items.slice(0, 12).join(" | "));
		document.querySelector(".modal-container .modal-bg")?.click();
		await until(() => !document.querySelector(".modal-container"), "picker closed");

		// Audio import: stage is visible and cancel leaves nothing behind.
		await nextSecond();
		await newWorkNote("작업2");
		await plugin.revealView();
		count = sessions().length;
		c.transcribeAudio = () => hang();
		clearNotices();
		run = c.importExisting(audio);
		await until(() => c.stage === "받아쓰는 중…", "transcribing stage");
		const panel = app.workspace.getLeavesOfType("voice-context-recorder")[0].view.contentEl;
		const cancelBtn = [...panel.querySelectorAll("button")].find((b) => b.textContent === "취소");
		check("panel shows the stage while importing", panel.querySelector(".vc-status").textContent === "받아쓰는 중…", panel.querySelector(".vc-status").textContent);
		check("panel hint is not the idle text while importing", !panel.querySelector(".vc-live").textContent.includes("녹음을 시작하면"), panel.querySelector(".vc-live").textContent);
		check("status bar shows the stage", document.querySelector(".voice-context-status").textContent === "받아쓰는 중…", document.querySelector(".voice-context-status").textContent);
		check("cancel button is visible while processing", cancelBtn && cancelBtn.offsetParent !== null);
		await until(() => noteText().includes("voice-context:pending"), "pending marker").catch(() => null);
		check("pending marker exists during the job", noteText().includes("voice-context:pending"), noteText());
		cancelBtn.click();
		await run;
		await sleep(150);
		check("cancelled audio import returns to idle", c.status === "idle" && c.stage === "", c.status);
		check("cancelled audio import leaves no session", sessions().length === count, sessions().map((s) => s.path).join());
		check("cancelled audio import removes the marker", !noteText().includes("voice-context"), noteText());
		check("cancelled audio import says so", noticed("가져오기를 취소했습니다"), notices().join(" | "));
		check("cancel button hides again", panel.querySelector("button") && [...panel.querySelectorAll("button")].find((b) => b.textContent === "취소").offsetParent === null);

		// Real llm path with a hung token: the abort race, not a stub, ends the job.
		await nextSecond();
		delete c.llm;
		plugin.summaryToken = () => new Promise(() => {});
		await newWorkNote("작업3");
		const source2 = await app.vault.create(`${ROOT}/원본2.md`, "두 번째 받아쓰기\n");
		await until(() => app.metadataCache.getFileCache(source2), "index");
		clearNotices();
		const startedAt = Date.now();
		run = c.importExisting(source2);
		await until(() => c.stage === "정리 중…", "summary stage");
		await sleep(200);
		c.cancel();
		await run;
		check("a hung summary request is cancellable", c.status === "idle" && Date.now() - startedAt < 3000, Date.now() - startedAt);
		check("cancelled summary keeps the transcript", (await read(newestSession())).includes("두 번째 받아쓰기"));
		check("cancelled summary writes no warning block", !noteText().includes("정리 실패") && !noteText().includes("voice-context"), noteText());
		check("cancelled summary points to rewrite", noticed("정리 다시 쓰기"), notices().join(" | "));
		plugin.summaryToken = realSummaryToken;
		stubLlm();

		// Recording with a synthetic stream, then continue, rewrite, retry.
		const ctx = new AudioContext();
		await ctx.resume();
		const osc = ctx.createOscillator();
		const dest = ctx.createMediaStreamDestination();
		osc.connect(dest);
		osc.start();
		navigator.mediaDevices.getUserMedia = async () => dest.stream.clone();

		await nextSecond();
		await newWorkNote("작업4-취소");
		c.transcribeAudio = () => hang();
		clearNotices();
		await c.start();
		await sleep(1500);
		const stopping = c.stop();
		await until(() => c.status === "processing", "stopping");
		await sleep(100);
		c.cancel();
		await stopping;
		check("cancelled recording with no transcript promises none", noticed("취소했습니다") && !noticed("받아쓴 글은 세션 노트에"), notices().join(" | "));

		await nextSecond();
		await newWorkNote("작업4");
		let segment = 0;
		c.transcribeAudio = async () => `세그먼트 받아쓰기 ${++segment}`;
		clearNotices();
		await c.start();
		check("recording starts", c.status === "recording", c.status);
		const rs = c.run.session;
		await c.addContext("메모", "참고 메모 내용");
		await sleep(2500);
		await c.stop();
		const rsText = await read(rs);
		check("stop writes transcript and audio to the session", rsText.includes("세그먼트 받아쓰기 1") && /!\[\[.*001\.(webm|m4a)\]\]/.test(rsText), rsText);
		check("context reaches the summary", llmCalls.at(-1)?.input.includes("참고 메모 내용"), llmCalls.at(-1)?.input);
		check("recording completion is announced", noticed("정리를 '작업4'에 넣었습니다"), notices().join(" | "));
		check("recording block is in the note", /voice-context:start[\s\S]*- 항목 둘\n\n> \[!quote\]-[\s\S]*voice-context:end/.test(noteText()), noteText());

		await nextSecond();
		clearNotices();
		await until(() => app.metadataCache.getFileCache(rs)?.frontmatter?.["voice-context"], "session index");
		const edited = noteText().replace("- 항목 하나", "- 항목 하나 (직접 고침)");
		leaf.view.editor.setValue(edited);
		await c.start(rs);
		check("continue recording starts", c.status === "recording", c.status);
		await sleep(2500);
		await c.stop();
		check("continue inserts without touching edited lines", noteText().includes("- 항목 하나 (직접 고침)") && noteText().includes("- 이어서 추가"), noteText());
		check("continue keeps the callout separated", /\n\n> \[!quote\]-/.test(noteText()), noteText());
		check("continue announces its change", noticed("1곳을 추가"), notices().join(" | "));

		await nextSecond();
		clearNotices();
		run = c.rewrite(rs);
		await clickModal("다시 쓰기");
		await run;
		check("rewrite overwrites and announces", noticed("정리를 다시 썼습니다") && !noteText().includes("이어서 추가"), notices().join(" | "));

		clearNotices();
		const beforeCancel = noteText();
		stubLlm(() => hang());
		run = c.rewrite(rs);
		await clickModal("다시 쓰기");
		await until(() => c.stage === "정리 중…", "rewrite stage");
		await sleep(100);
		c.cancel();
		await run;
		check("cancelled rewrite leaves the block intact", noteText() === beforeCancel && noticed("기존 정리는 그대로"), notices().join(" | "));
		stubLlm();

		// Failure paths log to the console and never claim success.
		await nextSecond();
		await newWorkNote("작업5");
		clearNotices();
		logged.length = 0;
		c.transcribeAudio = async () => {
			throw new Error("e2e transcribe failure");
		};
		await c.start();
		const fs = c.run.session;
		await sleep(2500);
		await c.stop();
		const fsText = await read(fs);
		check("failed segment leaves a marker", fsText.includes("voice-context:failed"), fsText);
		check("failed segment logs to the console", logged.some((l) => l.includes("[voice-context]") && l.includes("e2e transcribe failure")), logged.join(" | "));
		check("failed run does not announce a summary", !noticed("에 넣었습니다"), notices().join(" | "));

		clearNotices();
		c.transcribeAudio = async () => "다시 받아쓰기한 내용";
		await c.retryFailed(fs);
		const fsAfter = await read(fs);
		check("retry replaces the failed marker", fsAfter.includes("다시 받아쓰기한 내용") && !fsAfter.includes("voice-context:failed"), fsAfter);
		check("retry reports its count", noticed("1/1개"), notices().join(" | "));

		clearNotices();
		logged.length = 0;
		stubLlm(() => {
			throw new Error("e2e summary failure");
		});
		await until(() => app.metadataCache.getFileCache(fs)?.frontmatter, "session index");
		await c.rewrite(fs);
		await sleep(100);
		check("failed summary logs to the console", logged.some((l) => l.includes("[voice-context]") && l.includes("e2e summary failure")), logged.join(" | "));
		check("failed summary does not claim success", !noticed("다시 썼습니다") && noticed("정리 실패"), notices().join(" | "));
		delete c.llm;
		plugin.summaryToken = async () => {
			throw new Error("e2e no auth");
		};
		clearNotices();
		const authRun = c.rewrite(fs);
		await clickModal("다시 쓰기");
		const authStartedAt = performance.now();
		await authRun;
		check("missing auth fails without retry delay", performance.now() - authStartedAt < 900 && noticed("e2e no auth"), `${Math.round(performance.now() - authStartedAt)}ms ${notices().join(" | ")}`);
		plugin.summaryToken = realSummaryToken;
		stubLlm();
		osc.stop();
		await ctx.close();
		navigator.mediaDevices.getUserMedia = realGetUserMedia;
		delete navigator.mediaDevices.getUserMedia;

		// Settings commit on blur or Enter only. setApiKey and saveSettings are stubbed, so the real key and data.json stay out of reach.
		const keyCalls = [];
		plugin.setApiKey = (v) => keyCalls.push(v);
		plugin.setAzureKey = () => keyCalls.push("azure");
		let saves = 0;
		plugin.saveSettings = async () => void saves++;
		const modelBefore = plugin.settings.transcriptionModel;
		app.setting.open();
		app.setting.openTabById("voice-context");
		const settingsEl = await until(() => app.setting.modalEl?.querySelector(".vc-api-key input") && app.setting.modalEl, "settings tab");
		observer.observe(settingsEl.ownerDocument.body, { childList: true, subtree: true });
		const keyRow = [...settingsEl.querySelectorAll(".vc-api-key")].find(shown);
		const keyInput = keyRow.querySelector("input");
		check("key field stays masked", keyInput.type === "password", keyInput.type);
		check("key description names the keychain item", keyRow.textContent.includes("키체인 항목: "));
		keyInput.value = "sk-e2e-fake";
		keyInput.dispatchEvent(new Event("input", { bubbles: true }));
		check("typing in the key field saves nothing", keyCalls.length === 0, keyCalls.length);
		clearNotices();
		keyInput.dispatchEvent(new Event("change", { bubbles: true }));
		check("key field saves once on commit", keyCalls.length === 1 && keyCalls[0] === "sk-e2e-fake", keyCalls.length);
		await until(() => noticed("API 키를 저장했습니다"), "key notice").catch(() => null);
		check("key save is confirmed", noticed("API 키를 저장했습니다"), notices().join(" | "));
		const modelInput = [...settingsEl.querySelectorAll(".setting-item")].find((e) => e.querySelector(".setting-item-name")?.textContent === "받아쓰기 모델").querySelector("input");
		modelInput.value = "gpt-typo";
		modelInput.dispatchEvent(new Event("input", { bubbles: true }));
		check("typing in the model field saves nothing", plugin.settings.transcriptionModel === modelBefore && saves === 0, plugin.settings.transcriptionModel);
		clearNotices();
		modelInput.dispatchEvent(new Event("change", { bubbles: true }));
		await until(() => noticed("모델 목록에 없습니다"), "unknown model warning").catch(() => null);
		check("model field saves on commit", plugin.settings.transcriptionModel === "gpt-typo" && saves === 1, plugin.settings.transcriptionModel);
		check("unknown model warns on commit", noticed("모델 목록에 없습니다"), notices().join(" | "));
		modelInput.value = "  ";
		modelInput.dispatchEvent(new Event("change", { bubbles: true }));
		await sleep(50);
		check("empty model restores the saved value", modelInput.value === "gpt-typo" && plugin.settings.transcriptionModel === "gpt-typo", modelInput.value);
		plugin.settings.transcriptionModel = modelBefore;
		await closeSettings();
		delete plugin.setApiKey;
		delete plugin.setAzureKey;
		delete plugin.saveSettings;

		// Insert an existing session into the current note.
		const makeSession = async (name, id, section = "받아쓴 말", extra = "") => {
			const file = await app.vault.create(`${RECORDINGS}/${name}.md`, `---\nvoice-context: "${id}"\nduration: 120\nnotes: []\n---\n\n## Context\n\n## 받아쓰기\n\n${section}\n\n## 오디오\n${extra}`);
			await until(() => app.metadataCache.getFileCache(file)?.frontmatter?.["voice-context"], "session indexed");
			return file;
		};
		const insBlock = (id, line) => `\n%% voice-context:start ${id} %%\n### 정리 · 예전\n- ${line}\n%% voice-context:end %%\n`;
		const pendingLeft = () => noteText().includes("voice-context:pending");
		stubLlm();
		let insCalls = llmCalls.length;
		const insA = await makeSession("넣기 세션A", "20990102-000001", "받아쓴 말", insBlock("20990102-000001", "기존 요약"));
		await newWorkNote("작업8", "첫 줄\n둘째 줄\n");
		leaf.view.editor.setCursor({ line: 0, ch: 0 });
		await c.insertSession(insA);
		check(
			"insert: the summary lands under the cursor with a transcript link",
			/^첫 줄\n\n%% voice-context:start 20990102-000001 %%\n### 정리 · 예전\n- 기존 요약\n\n> \[!quote\]- [^\n]*\|세션\]\] · 2분\n> !\[\[[^\n]*#받아쓰기\]\]\n%% voice-context:end %%\n\n둘째 줄/.test(noteText()),
			noteText(),
		);
		check("insert: an existing summary costs no model call", llmCalls.length === insCalls && !pendingLeft() && c.status === "idle", llmCalls.length);
		const insAText = await read(insA);
		check("insert: the session keeps its block and links the note", insAText.includes("- 기존 요약") && insAText.includes("[[") && /notes:[\s\S]*작업8/.test(insAText), insAText);
		// The frontmatter edit above re-indexes the session.
		await until(() => app.metadataCache.getFileCache(insA)?.frontmatter?.["voice-context"], "session reindexed");
		clearNotices();
		const onceText = noteText();
		await c.insertSession(insA);
		check("insert: a second insert into the same note adds nothing", noteText() === onceText && noticed("이미 '작업8'"), notices().join(" | "));

		const insB = await makeSession("넣기 세션B", "20990102-000002");
		insCalls = llmCalls.length;
		await c.insertSession(insB);
		check("insert: a session without a summary gets one", llmCalls.length === insCalls + 1 && noteText().includes("voice-context:start 20990102-000002") && noteText().includes("- 항목 둘") && !pendingLeft(), noteText());
		check("insert: the new summary links the note from the session", /notes:[\s\S]*작업8/.test(await read(insB)), await read(insB));

		const insC = await makeSession("넣기 세션C", "20990102-000003");
		const insBeforeCancel = noteText();
		stubLlm(() => hang());
		insCalls = llmCalls.length;
		let insRun = c.insertSession(insC);
		await until(() => llmCalls.length > insCalls, "insert summary call");
		check("insert: the marker holds the place while summarizing", pendingLeft());
		c.cancel();
		await insRun;
		check("insert: cancel restores the note", noteText() === insBeforeCancel && c.status === "idle", noteText());
		stubLlm();

		const insEmpty = await makeSession("넣기 세션D", "20990102-000004", "");
		clearNotices();
		insCalls = llmCalls.length;
		await c.insertSession(insEmpty);
		check("insert: an empty session changes nothing", noteText() === insBeforeCancel && llmCalls.length === insCalls && noticed("받아쓴 내용도 없습니다"), notices().join(" | "));

		c.setStatus("processing", "e2e");
		clearNotices();
		await c.insertSession(insB);
		check("insert: refused while busy", noticed("끝난 뒤에") && noteText() === insBeforeCancel, notices().join(" | "));
		c.setStatus("idle");

		await leaf.openFile(insB, { state: { mode: "source", source: false } });
		app.workspace.setActiveLeaf(leaf, { focus: false });
		await sleep(150);
		const insBText = noteText();
		clearNotices();
		await c.insertSession(insB);
		check("insert: a session cannot go into itself", noteText() === insBText && noticed("세션 노트에는"), notices().join(" | "));

		const insE = await makeSession("넣기 세션E", "20990102-000005", "받아쓴 말", insBlock("20990102-000005", "읽기 보기 요약"));
		await newWorkNote("작업9", "본문\n");
		await leaf.setViewState({ type: "markdown", state: { file: work.path, mode: "preview" }, active: true });
		app.workspace.setActiveLeaf(leaf, { focus: false });
		await sleep(200);
		await c.insertSession(insE);
		await sleep(100);
		const readingText = await read(work);
		check("insert: reading view puts it at the end of the note", readingText.startsWith("본문") && readingText.includes("- 읽기 보기 요약") && !readingText.includes("voice-context:pending"), readingText);

		// The button: focus sits in the sidebar, and the target is still the note behind it.
		const insF = await makeSession("넣기 세션F", "20990102-000006", "받아쓴 말", insBlock("20990102-000006", "버튼 요약"));
		await newWorkNote("작업10", "버튼 본문\n");
		const panelsBefore = app.workspace.getLeavesOfType("voice-context-recorder").length;
		if (!panelsBefore) await plugin.revealView();
		const panelLeaf = app.workspace.getLeavesOfType("voice-context-recorder")[0];
		const insertBtn = await until(() => panelLeaf.view.contentEl.querySelector('button[aria-label="현재 노트에 넣기"]'), "insert button");
		check("insert button has an icon", insertBtn.querySelector("svg"));
		c.setStatus("processing", "e2e");
		check("insert button hides while busy", insertBtn.style.display === "none", insertBtn.style.display);
		c.setStatus("idle");
		check("insert button shows when idle", insertBtn.style.display !== "none", insertBtn.style.display);
		app.workspace.setActiveLeaf(panelLeaf, { focus: true });
		await sleep(100);
		insertBtn.click();
		const insItem = await until(() => [...document.querySelectorAll(".modal-container .suggestion-item")].find((e) => e.textContent === "넣기 세션F"), "insert picker");
		insItem.click();
		await until(() => c.status === "idle" && !document.querySelector(".modal-container"), "insert picked");
		await until(async () => (await readNote()).includes("- 버튼 요약"), "button insert").catch(() => null);
		check("insert button: picking a session fills the note behind the panel", (await readNote()).includes("- 버튼 요약"), await readNote());
		if (!panelsBefore) panelLeaf.detach();
		app.workspace.setActiveLeaf(leaf, { focus: false });

		// Segment delete: a session with two own segments and one original from elsewhere.
		const segName = "세션 작업7";
		const segDir = `${RECORDINGS}/${segName}`;
		await app.vault.createFolder(segDir);
		const seg1 = await app.vault.createBinary(`${segDir}/001.wav`, wav());
		const seg2 = await app.vault.createBinary(`${segDir}/002.wav`, wav());
		const original = await app.vault.createBinary(`${ROOT}/원본.wav`, wav());
		const embeds = `![[${seg1.path}]]\n\n![[${seg2.path}]]\n\n![[${original.path}]]\n`;
		const segBody = (id) => `---\nvoice-context: "${id}"\n---\n\n## 받아쓰기\n\n받아쓴 말\n\n%% voice-context:failed ${seg2.path} %%\n\n## 오디오\n\n${embeds}`;
		const segSession = await app.vault.create(`${RECORDINGS}/${segName}.md`, segBody("20990101-000000"));
		const stray = await app.vault.create(`${ROOT}/폴더밖 작업7.md`, segBody("20990101-000001"));
		const plain = await app.vault.create(`${RECORDINGS}/일반 작업7.md`, embeds);
		await until(() => [segSession, stray, plain].every((f) => app.metadataCache.getFileCache(f)?.embeds?.length === 3), "segment notes indexed");
		// The hidden editor behind a reading view holds its own copy of each embed.
		const buttons = () => [...leaf.view.contentEl.querySelectorAll(".vc-segment-delete")].filter(shown);
		const openAs = async (file, mode) => {
			await leaf.openFile(file, { state: { mode, source: false } });
			app.workspace.setActiveLeaf(leaf, { focus: false });
			if (mode === "preview") leaf.view.previewMode.rerender(true);
			await sleep(400);
		};
		await openAs(segSession, "preview");
		await until(() => buttons().length === 2, "reading view buttons").catch(() => null);
		check("reading view: only own segments get a button", buttons().length === 2 && buttons().every((b) => /00[12]\.wav 삭제/.test(b.getAttribute("aria-label"))), buttons().map((b) => b.getAttribute("aria-label")).join());
		leaf.view.previewMode.rerender(true);
		await sleep(400);
		check("reading view: a re-render keeps the buttons", buttons().length === 2, buttons().length);
		await openAs(stray, "preview");
		check("session outside the folder gets no button", buttons().length === 0, buttons().length);
		await openAs(plain, "preview");
		check("ordinary note gets no button", buttons().length === 0, buttons().length);
		await openAs(segSession, "source");
		await until(() => buttons().length === 2, "live preview buttons").catch(() => null);
		check("live preview: only own segments get a button", buttons().length === 2, buttons().length);
		const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
		const cursorBefore = leaf.view.editor.getCursor().line;
		buttons()[1].dispatchEvent(down);
		check("live preview: the button keeps the click from the editor", down.defaultPrevented && leaf.view.editor.getCursor().line === cursorBefore, down.defaultPrevented);
		clearNotices();
		c.setStatus("processing", "e2e");
		await c.deleteSegment(segSession, seg2);
		c.setStatus("idle");
		check("delete waits while a job runs", noticed("끝난 뒤에") && !!app.vault.getFileByPath(seg2.path), notices().join(" | "));
		buttons()[1].click();
		const askDelete = await clickModal("취소");
		check("delete asks first and says what stays", askDelete.includes("002.wav") && askDelete.includes("그대로"), askDelete);
		await sleep(100);
		check("cancel keeps the file and the embed", !!app.vault.getFileByPath(seg2.path) && noteText().includes(`![[${seg2.path}]]`));
		buttons()[1].click();
		await clickModal("삭제");
		await until(() => !app.vault.getFileByPath(seg2.path), "segment deleted");
		await until(() => c.status === "idle", "delete finished");
		const afterLive = noteText();
		check("live preview delete removes the file, embed and marker", !afterLive.includes(seg2.path), afterLive);
		check("live preview delete keeps the transcript and the rest", afterLive.includes("받아쓴 말") && afterLive.includes(`![[${seg1.path}]]`) && afterLive.includes(`![[${original.path}]]`), afterLive);
		check("deleted segment goes to the vault trash", (await app.vault.adapter.list(".trash")).files.some((f) => !trashBefore.has(f) && f.endsWith("002.wav")));
		await leaf.view.save();
		await openAs(segSession, "preview");
		await until(() => buttons().length === 1, "one button left").catch(() => null);
		buttons()[0]?.click();
		await clickModal("삭제");
		await until(() => !app.vault.getFileByPath(seg1.path), "reading view delete");
		await until(() => c.status === "idle", "delete finished");
		const afterRead = await read(segSession);
		check("reading view delete edits the saved note", !afterRead.includes(seg1.path) && afterRead.includes(`![[${original.path}]]`), afterRead);
		check("the original outside the session is untouched", !!app.vault.getFileByPath(original.path));

		// Azure: the real conversion and request code against a local server. No key or account is involved.
		const http = window.require("http");
		const received = [];
		let azureReply = { status: 200, body: { combinedPhrases: [{ text: "## 애저 받아쓰기" }] } };
		const server = http.createServer((req, res) => {
			const chunks = [];
			req.on("data", (x) => chunks.push(x));
			req.on("end", () => {
				received.push({ url: req.url, key: req.headers["ocp-apim-subscription-key"], body: Buffer.concat(chunks) });
				res.writeHead(azureReply.status, { "Content-Type": "application/json" });
				res.end(JSON.stringify(azureReply.body));
			});
		});
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		const stubTranscribe = c.transcribeAudio;
		delete c.transcribeAudio;
		try {
			plugin.azureKey = () => "e2e-azure-key";
			Object.assign(plugin.settings, { transcriptionProvider: "azure", azureEndpoint: "", azureModel: "MAI-Transcribe-2" });
			check("azure needs an endpoint", plugin.transcriptionProblem()?.includes("엔드포인트"), plugin.transcriptionProblem());
			plugin.settings.azureEndpoint = `http://127.0.0.1:${server.address().port}/`;
			check("azure is ready with an endpoint and key", plugin.transcriptionProblem() === null, plugin.transcriptionProblem());

			const audioCtx = new AudioContext();
			const toneDest = audioCtx.createMediaStreamDestination();
			const tone = audioCtx.createOscillator();
			tone.connect(toneDest);
			tone.start();
			const recorder = new MediaRecorder(toneDest.stream, { mimeType: "audio/webm;codecs=opus" });
			const webmChunks = [];
			recorder.ondataavailable = (e) => webmChunks.push(e.data);
			const recorded = new Promise((r) => (recorder.onstop = r));
			recorder.start();
			await sleep(1200);
			recorder.stop();
			await recorded;
			tone.stop();
			await audioCtx.close();
			const webm = await new Blob(webmChunks).arrayBuffer();

			const azureText = await c.transcribeAudio(webm, "001.webm", "audio/webm;codecs=opus", "앞 문맥");
			check("azure returns the demoted transcript", azureText === "##### 애저 받아쓰기", azureText);
			const sent = received[0];
			const head = sent?.body.toString("latin1") ?? "";
			check("azure posts to the documented route", sent?.url === "/speechtotext/transcriptions:transcribe?api-version=2025-10-15", sent?.url);
			check("azure sends its key header", sent?.key === "e2e-azure-key");
			check("azure sends the model and locale", head.includes('"locales":["ko"]') && head.includes('"enhancedMode":{"enabled":true,"model":"MAI-Transcribe-2","modelOptions":{"transcribeStyle":"verbatim"}}') && !head.includes("phraseList"), head.slice(0, 400));
			check("azure uploads real webm as wav", head.includes('name="audio"; filename="001.wav"') && head.includes("Content-Type: audio/wav") && /RIFF.{4}WAVEfmt /s.test(head), head.slice(0, 500));
			const samples = (() => {
				const at = sent.body.indexOf("data", sent.body.indexOf("WAVEfmt "));
				return sent.body.readUInt32LE(at + 4) / 2;
			})();
			check("azure wav holds the decoded 16 kHz audio", samples > 16000 * 0.5 && samples < 16000 * 3, samples);
			check("azure omits the free-form prompt", !head.includes("앞 문맥"));
			await c.transcribeAudio(wav(), "tone.wav", "audio/wav", "");
			check("azure sends wav as it is", received[1].body.toString("latin1").includes('filename="tone.wav"'));
			azureReply = { status: 200, body: { combinedPhrases: [] } };
			check("azure silence is an empty transcript", (await c.transcribeAudio(wav(), "tone.wav", "audio/wav", "")) === "");
			azureReply = { status: 400, body: { code: "InvalidRequest", message: "e2e bad audio", innerError: { code: "InvalidAudioFormat" } } };
			const azureError = await c.transcribeAudio(wav(), "tone.wav", "audio/wav", "").catch((e) => e);
			check("azure errors keep the service message", azureError?.message === "e2e bad audio" && azureError?.code === "InvalidAudioFormat", azureError?.message);

			// Presets: the active one goes on the wire, and the agent's choice re-transcribes through the same route.
			const definitionOf = (r) => r.body.toString("latin1");
			azureReply = { status: 200, body: { combinedPhrases: [{ text: "프리셋 받아쓰기" }] } };
			plugin.saveSettings = async () => {};

			// Usage: only lengths the service reports count, and the settings row reads them back later.
			const usageMonth = new Date().toISOString().slice(0, 7);
			plugin.settings.azureUsageMs = { "2000-01": 60_000 };
			await c.transcribeAudio(wav(), "tone.wav", "audio/wav", "");
			check("azure without a length adds no usage", JSON.stringify(plugin.settings.azureUsageMs) === '{"2000-01":60000}', JSON.stringify(plugin.settings.azureUsageMs));
			azureReply = { status: 200, body: { durationMilliseconds: 120_000, combinedPhrases: [{ text: "프리셋 받아쓰기" }] } };
			await c.transcribeAudio(wav(), "tone.wav", "audio/wav", "");
			check("azure adds the reported length to this month", plugin.settings.azureUsageMs[usageMonth] === 120_000 && plugin.settings.azureUsageMs["2000-01"] === 60_000, JSON.stringify(plugin.settings.azureUsageMs));
			azureReply = { status: 400, body: { code: "InvalidRequest", message: "e2e bad audio" } };
			await c.transcribeAudio(wav(), "tone.wav", "audio/wav", "").catch(() => null);
			check("azure failure adds no usage", plugin.settings.azureUsageMs[usageMonth] === 120_000, JSON.stringify(plugin.settings.azureUsageMs));
			azureReply = { status: 200, body: { combinedPhrases: [{ text: "프리셋 받아쓰기" }] } };

			Object.assign(plugin.settings, {
				azureTranscribeStyle: "clean",
				phrasePresets: [{ name: "회의", phrases: ["가나다"] }],
				activePreset: "회의",
			});
			received.length = 0;
			await c.transcribeAudio(wav(), "tone.wav", "audio/wav", "");
			check("azure sends the style and active preset", definitionOf(received[0]).includes('"transcribeStyle":"clean"') && Buffer.from(received[0].body).toString("utf8").includes('"phraseList":{"phrases":["가나다"]}'), Buffer.from(received[0].body).toString("utf8").slice(0, 400));
			plugin.settings.activePreset = "지운 프리셋";
			received.length = 0;
			await c.transcribeAudio(wav(), "tone.wav", "audio/wav", "");
			check("azure omits a preset that no longer exists", !definitionOf(received[0]).includes("phraseList"));
			plugin.settings.activePreset = "회의";

			await nextSecond();
			const presetAudio = await app.vault.createBinary(`${ROOT}/프리셋 원본.wav`, wav());
			await nextSecond();
			await newWorkNote("작업프리셋", "프리셋 메모\n");
			const sessionsBeforePreset = new Set(sessions());
			c.transcribeAudio = stubTranscribe;
			await c.importExisting(presetAudio);
			delete c.transcribeAudio;
			const presetSession = sessions().find((f) => !sessionsBeforePreset.has(f));
			await until(() => app.metadataCache.getFileCache(presetSession)?.frontmatter, "preset session index");
			const beforePreset = await app.vault.read(presetSession);
			const decide = (over) => JSON.stringify({ preset: "회의", add: ["라마바"], remove: ["가나다"], retranscribe: true, reason: "e2e 근거", ...over });

			stubLlm(() => decide({}));
			clearNotices();
			let judged = c.judgePreset(presetSession);
			const shownDecision = await clickModal("취소");
			await judged;
			check("judge shows reason and edits before acting", shownDecision.includes("e2e 근거") && shownDecision.includes("추가: 라마바") && shownDecision.includes("삭제: 가나다") && shownDecision.includes("요금"), shownDecision);
			check("judge cancel changes nothing", plugin.settings.phrasePresets[0].phrases.join() === "가나다" && (await app.vault.read(presetSession)) === beforePreset);
			check("judge sends only its own rules", llmCalls.at(-1)?.rules.includes("phraseList") && llmCalls.at(-1)?.input.includes('"name":"회의"'), llmCalls.at(-1)?.input.slice(0, 200));

			judged = c.judgePreset(presetSession);
			await clickModal("프리셋만 저장");
			await judged;
			check("judge can edit only the preset", plugin.settings.phrasePresets[0].phrases.join() === "라마바" && (await app.vault.read(presetSession)) === beforePreset, plugin.settings.phrasePresets[0].phrases.join());
			check("judge reports the preset change", noticed("+1 -1"), notices().join(" | "));

			azureReply = { status: 400, body: { code: "InvalidRequest", message: "e2e preset failure" } };
			clearNotices();
			await c.applyPresetDecision(presetSession, { preset: "회의", add: [], remove: [], retranscribe: true, reason: "" });
			check("failed re-transcription keeps the transcript", (await app.vault.read(presetSession)) === beforePreset && noticed("e2e preset failure"), notices().join(" | "));

			azureReply = { status: 200, body: { combinedPhrases: [{ text: "프리셋 받아쓰기" }] } };
			received.length = 0;
			stubLlm(() => decide({ add: ["사아자"], remove: [] }));
			judged = c.judgePreset(presetSession);
			await clickModal("다시 받아쓰기");
			await judged;
			const afterPreset = await app.vault.read(presetSession);
			const transcriptPart = afterPreset.slice(afterPreset.indexOf("## 받아쓰기"), afterPreset.indexOf("## 오디오"));
			const archivePart = afterPreset.slice(afterPreset.indexOf("## 이전 받아쓰기"));
			const oldTranscript = beforePreset.slice(beforePreset.indexOf("## 받아쓰기") + "## 받아쓰기".length, beforePreset.indexOf("## 오디오")).trim();
			check("re-transcription uses the chosen preset", Buffer.from(received[0]?.body ?? []).toString("utf8").includes('"phrases":["라마바","사아자"]'), Buffer.from(received[0]?.body ?? []).toString("utf8").slice(0, 400));
			check("re-transcription replaces the transcript", transcriptPart.includes("프리셋 받아쓰기") && transcriptPart.includes("다시 받아쓰기 · 회의") && !transcriptPart.includes(oldTranscript), transcriptPart);
			check("re-transcription keeps the old text", oldTranscript && archivePart.includes(oldTranscript), archivePart);
			check("re-transcription keeps the audio embed", afterPreset.slice(afterPreset.indexOf("## 오디오")).includes(presetAudio.path));
			check("re-transcription keeps the preset for new recordings", plugin.settings.activePreset === "회의");

			// Settings: the dropdown swaps the fields, and the key stays masked. Nothing here reaches data.json or the keychain.
			Object.assign(plugin.settings, { transcriptionProvider: "openai" });
			plugin.saveData = async () => {};
			const azureKeyCalls = [];
			plugin.setAzureKey = (v) => azureKeyCalls.push(v);
			app.setting.open();
			app.setting.openTabById("voice-context");
			const panel = await until(() => app.setting.modalEl?.querySelector(".vc-api-key input") && app.setting.modalEl, "settings tab");
			const names = () => [...panel.querySelectorAll(".setting-item")].filter(shown).map((e) => e.querySelector(".setting-item-name")?.textContent);
			check("settings: azure fields stay hidden for openai", !names().includes("Azure 키") && names().includes("받아쓰기 모델"), names().join());
			const providerRow = [...panel.querySelectorAll(".setting-item")].find((e) => e.querySelector(".setting-item-name")?.textContent === "받아쓰기 제공자");
			const select = providerRow.querySelector("select");
			select.value = "azure";
			select.dispatchEvent(new Event("change", { bubbles: true }));
			await until(() => names().includes("Azure 키"), "azure fields").catch(() => null);
			check("settings: choosing azure shows its fields", names().includes("Azure 엔드포인트") && names().includes("Azure 키") && names().includes("Azure 모델") && !names().includes("받아쓰기 모델"), names().join());
			const pick = () => app.workspace.getLeavesOfType("voice-context-recorder")[0]?.view.contentEl.querySelector(".vc-preset-pick");
			check("panel: the preset choice shows for azure", pick()?.style.display !== "none" && pick()?.querySelector("select")?.value === "회의", pick()?.outerHTML.slice(0, 300));
			const usageRow = [...panel.querySelectorAll(".setting-item")].find((e) => e.querySelector(".setting-item-name")?.textContent === "Azure 사용량");
			check("settings: usage shows this month and the total", usageRow?.textContent.includes("이번 달(UTC) 2.0분") && usageRow?.textContent.includes("전체 3.0분"), usageRow?.textContent);
			const openBefore = window.open;
			let openedUrl = "";
			window.open = (url) => void (openedUrl = url);
			usageRow?.querySelector("button")?.click();
			window.open = openBefore;
			check("settings: usage opens the cost page", openedUrl.startsWith("https://portal.azure.com/"), openedUrl);
			check("settings: the choice is stored", plugin.settings.transcriptionProvider === "azure", plugin.settings.transcriptionProvider);
			const azureRow = [...panel.querySelectorAll(".setting-item")].find((e) => e.querySelector(".setting-item-name")?.textContent === "Azure 키");
			const azureInput = azureRow?.querySelector("input");
			check("settings: azure key stays masked", azureInput?.type === "password", azureInput?.type);
			if (azureInput) {
				azureInput.value = "azure-e2e-fake";
				azureInput.dispatchEvent(new Event("change", { bubbles: true }));
			}
			check("settings: azure key saves through its own secret", azureKeyCalls.length === 1 && azureKeyCalls[0] === "azure-e2e-fake", azureKeyCalls.length);
			const row = (name) => [...panel.querySelectorAll(".setting-item")].find((e) => e.querySelector(".setting-item-name")?.textContent === name);
			check("settings: style and active preset show for azure", row("받아쓰기 스타일")?.querySelector("select")?.value === "clean" && row("새 녹음에 쓸 프리셋")?.querySelector("select")?.value === "회의", names().join());
			const settingPick = row("새 녹음에 쓸 프리셋").querySelector("select");
			settingPick.value = "";
			settingPick.dispatchEvent(new Event("change", { bubbles: true }));
			await until(() => pick()?.querySelector("select")?.value === "", "panel follows settings").catch(() => null);
			check("panel: follows the settings choice", pick()?.querySelector("select")?.value === "" && plugin.settings.activePreset === "", plugin.settings.activePreset);
			const panelPick = pick().querySelector("select");
			panelPick.value = "회의";
			panelPick.dispatchEvent(new Event("change", { bubbles: true }));
			await until(() => row("새 녹음에 쓸 프리셋")?.querySelector("select")?.value === "회의", "settings follows panel").catch(() => null);
			check("panel: choosing a preset updates settings", plugin.settings.activePreset === "회의" && row("새 녹음에 쓸 프리셋")?.querySelector("select")?.value === "회의", plugin.settings.activePreset);
			row("프리셋 추가").querySelector("button").click();
			await until(() => row("새 프리셋"), "new preset row").catch(() => null);
			const newRow = row("새 프리셋");
			check("settings: a preset can be added", !!newRow && plugin.settings.phrasePresets.some((p) => p.name === "새 프리셋"), names().join());
			const area = newRow.querySelector("textarea");
			area.value = "하나, 둘\n하나";
			area.dispatchEvent(new Event("change", { bubbles: true }));
			check("settings: phrases are split and deduplicated", plugin.settings.phrasePresets.find((p) => p.name === "새 프리셋")?.phrases.join() === "하나,둘", plugin.settings.phrasePresets.at(-1)?.phrases.join());
			const nameInput = newRow.querySelector('input[type="text"]');
			nameInput.value = "회의";
			nameInput.dispatchEvent(new Event("change", { bubbles: true }));
			check("settings: a duplicate preset name is refused", nameInput.value === "새 프리셋" && plugin.settings.phrasePresets.filter((p) => p.name === "회의").length === 1, nameInput.value);
			const firstName = row("회의").querySelector('input[type="text"]');
			firstName.value = "회의2";
			firstName.dispatchEvent(new Event("change", { bubbles: true }));
			await until(() => row("회의2"), "renamed preset").catch(() => null);
			check("settings: renaming follows the active preset", plugin.settings.activePreset === "회의2", plugin.settings.activePreset);
			row("회의2").querySelector(".clickable-icon").click();
			await until(() => !row("회의2"), "deleted preset").catch(() => null);
			check("settings: deleting clears the active preset", plugin.settings.activePreset === "" && !plugin.settings.phrasePresets.some((p) => p.name === "회의2"), plugin.settings.activePreset);
			const phrasesShown = (root, phrase) => [...root.querySelectorAll(".setting-item")].find((e) => e.querySelector(".setting-item-name")?.textContent === "새 프리셋")?.querySelector("textarea")?.value.includes(phrase);
			await c.applyPresetDecision(presetSession, { preset: "새 프리셋", add: ["셋"], remove: [], retranscribe: false, reason: "" });
			await until(() => phrasesShown(panel, "셋"), "agent save in the open tab").catch(() => null);
			check("settings: an agent save shows in the open tab", phrasesShown(panel, "셋"), plugin.settings.phrasePresets.at(-1)?.phrases.join());
			await closeSettings();
			await c.applyPresetDecision(presetSession, { preset: "새 프리셋", add: ["넷"], remove: [], retranscribe: false, reason: "" });
			app.setting.open();
			app.setting.openTabById("voice-context");
			await until(() => phrasesShown(app.setting.modalEl, "넷"), "agent save after reopening").catch(() => null);
			check("settings: an agent save shows after reopening", phrasesShown(app.setting.modalEl, "넷"), plugin.settings.phrasePresets.at(-1)?.phrases.join());
			const typedArea = [...app.setting.modalEl.querySelectorAll(".setting-item")].find((e) => e.querySelector(".setting-item-name")?.textContent === "새 프리셋")?.querySelector("textarea");
			typedArea.value = `${typedArea.value}\n다섯`;
			typedArea.dispatchEvent(new Event("change", { bubbles: true }));
			await closeSettings();
			app.setting.open();
			app.setting.openTabById("voice-context");
			await until(() => phrasesShown(app.setting.modalEl, "다섯"), "typed phrases after reopening").catch(() => null);
			check("settings: typed phrases show after reopening", phrasesShown(app.setting.modalEl, "다섯"), plugin.settings.phrasePresets.at(-1)?.phrases.join());
			await closeSettings();
		} finally {
			server.close();
			c.transcribeAudio = stubTranscribe;
			Object.assign(plugin.settings, { ...azureBefore, transcriptionProvider: "openai" });
			delete plugin.saveSettings;
			stubLlm();
			delete plugin.azureKey;
			delete plugin.setAzureKey;
			delete plugin.saveData;
		}

		if (window.__vcE2ELive) {
			delete c.llm;
			delete c.transcribeAudio;
			let liveTranscribe = null;
			try {
				liveTranscribe = await c.transcribeAudio(wav(), "tone.wav", "audio/wav", "");
				check("live: transcription accepts languages[]", typeof liveTranscribe === "string");
			} catch (e) {
				check("live: transcription accepts languages[]", false, e.message);
			}

			await nextSecond();
			await newWorkNote("작업6", "참고: 우리 서버 이름의 정확한 표기는 Poteto다. 사내 식당의 오늘 메뉴는 비빔밥이다.\n");
			leaf.view.editor.setSelection({ line: 0, ch: 0 }, { line: 0, ch: leaf.view.editor.getLine(0).length });
			const liveSource = await app.vault.create(`${ROOT}/라이브 받아쓰기.md`, "오늘 회의에서 포테이토 서버 배포 일정을 금요일로 정했다. 담당은 민수다.\n");
			await until(() => app.metadataCache.getFileCache(liveSource), "index");
			clearNotices();
			await c.importExisting(liveSource);
			const liveBlock = noteText().slice(noteText().indexOf("voice-context:start"));
			check("live: summary uses the transcript", liveBlock.includes("금요일"), liveBlock);
			check("live: context stays out of the summary", !liveBlock.includes("비빔밥"), liveBlock);
			check("live: context corrects a misheard term", liveBlock.includes("Poteto"), liveBlock);
			check("live: summary completes", noticed("에 넣었습니다"), notices().join(" | "));
		}
	} catch (e) {
		report.error = e?.stack ?? String(e);
	} finally {
		try {
			if (c.status === "processing") c.cancel();
			if (c.status === "recording" || c.status === "paused") await c.stop();
			while (document.querySelector(".modal-container .modal-bg")) {
				document.querySelector(".modal-container .modal-bg").click();
				await sleep(50);
			}
			await closeSettings();
		} catch {}
		delete c.llm;
		delete c.transcribeAudio;
		delete plugin.setApiKey;
		delete plugin.saveSettings;
		plugin.summaryToken = realSummaryToken;
		delete plugin.summaryToken;
		delete navigator.mediaDevices.getUserMedia;
		plugin.settings.recordingsFolder = folderBefore;
		Object.assign(plugin.settings, azureBefore);
		plugin.settingTab.update();
		plugin.refreshPanels();
		delete plugin.azureKey;
		delete plugin.setAzureKey;
		delete plugin.saveData;
		console.error = realConsoleError;
		observer.disconnect();
		await leaf?.view?.save?.();
		leaf?.detach();
		await sleep(300);
		if (!panelBefore) for (const l of app.workspace.getLeavesOfType("voice-context-recorder")) l.detach();
		const folder = app.vault.getAbstractFileByPath(ROOT);
		if (folder && ownsRoot) await app.vault.delete(folder, true);
		for (const f of (await app.vault.adapter.list(".trash").catch(() => ({ files: [] }))).files) {
			if (!trashBefore.has(f) && (/ 작업\d/.test(f) || /\/00[12]( \d+)?\.wav$/.test(f))) await app.vault.adapter.remove(f);
		}
		if (activeBefore) app.workspace.iterateRootLeaves((l) => l.view?.file?.path === activeBefore && app.workspace.setActiveLeaf(l, { focus: false }));
		check("cleanup: temp folder is gone", !ownsRoot || !app.vault.getAbstractFileByPath(ROOT));
		const pickOptions = [...(app.workspace.getLeavesOfType("voice-context-recorder")[0]?.view.contentEl.querySelectorAll(".vc-preset-pick option") ?? [])].map((o) => o.value).filter(Boolean);
		check("cleanup: the panel lists the real presets", !pickOptions.length || pickOptions.join() === plugin.settings.phrasePresets.map((p) => p.name).join(), pickOptions.join());
		const listed = [...(app.workspace.getLeavesOfType("voice-context-recorder")[0]?.view.contentEl.querySelectorAll(".vc-session-name") ?? [])].map((a) => a.textContent);
		check("cleanup: the panel lists only real sessions", listed.every((n) => app.vault.getMarkdownFiles().some((f) => f.basename === n)), listed.join());
		check("cleanup: data.json is unchanged", (await app.vault.adapter.read(dataPath)) === dataBefore);
		check("cleanup: API key is unchanged", plugin.apiKey() === keyBefore);
		check("cleanup: Azure key is unchanged", plugin.azureKey() === azureKeyBefore);
		await sleep(1000);
		window.removeEventListener("unhandledrejection", onRejection);
		check("cleanup: no unhandled rejections", rejections.length === 0, rejections.join(" || "));
		const probe = await app.vault.create("_vc-e2e-resolver-probe.md", "");
		await until(() => app.metadataCache.getFileCache(probe), "probe index");
		const drained = await until(() => app.metadataCache.resolvedLinks[probe.path], "link resolver").catch(() => null);
		await app.vault.delete(probe);
		check("cleanup: link resolver still runs", drained, "linkResolverQueue stopped");
		check("cleanup: active note is restored", app.workspace.getActiveFile()?.path === activeBefore, app.workspace.getActiveFile()?.path);
		report.done = true;
	}
})();
