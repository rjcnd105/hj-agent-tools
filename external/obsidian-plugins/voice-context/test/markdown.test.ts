import { describe, expect, test } from "bun:test";
import {
	END_MARKER,
	appendToSection,
	applyInsertions,
	blockIdAt,
	demoteHeadings,
	diffRange,
	extractLinks,
	extractSection,
	findBlock,
	findPending,
	importHeading,
	importMarker,
	modelSuggestions,
	numberLines,
	parseContextEntries,
	parseInsertions,
	pendingMarker,
	removeSegmentLines,
	renderBlock,
	renderCallout,
	renderContextEntry,
	startMarker,
	stripMarkers,
	transcriptFromNote,
} from "../src/markdown";

const session = "---\nvoice-context: 1\n---\n\n## Context\n\n## 받아쓰기\n\n## 오디오\n";

describe("sections", () => {
	test("append keeps following sections and blank lines", () => {
		let t = appendToSection(session, "받아쓰기", "### 2026-10-29 14:10");
		t = appendToSection(t, "받아쓰기", "첫 문장");
		t = appendToSection(t, "오디오", "![[a/001.webm]]");
		expect(t).toBe(
			"---\nvoice-context: 1\n---\n\n## Context\n\n## 받아쓰기\n\n### 2026-10-29 14:10\n\n첫 문장\n\n## 오디오\n\n![[a/001.webm]]\n",
		);
		expect(extractSection(t, "받아쓰기")).toBe("### 2026-10-29 14:10\n\n첫 문장");
		expect(extractSection(t, "Context")).toBe("");
	});

	test("missing section is appended", () => {
		expect(appendToSection("# x", "받아쓰기", "a")).toBe("# x\n\n## 받아쓰기\n\na\n");
	});

	test("context entries round-trip through quotes", () => {
		const t = appendToSection(session, "Context", renderContextEntry("14:10 · 선택 영역 · [[회의]]", "- a [[b]]\n\n## 소제목"));
		expect(extractSection(t, "받아쓰기")).toBe("");
		expect(parseContextEntries(extractSection(t, "Context"))).toEqual([
			{ title: "14:10 · 선택 영역 · [[회의]]", body: "- a [[b]]\n\n## 소제목" },
		]);
	});

	test("transcriptFromNote drops frontmatter and earlier summary blocks", () => {
		const block = renderBlock("1", "### 정리\n- 요약", renderCallout("세션", 3));
		expect(transcriptFromNote(`---\ntags: [a]\n---\n오늘 회의\n\n${block}\n\n결론 --- 끝\n${pendingMarker("2")}`)).toBe("오늘 회의\n\n결론 --- 끝");
		expect(transcriptFromNote(`---\ntags: [a]\n---\n${block}`)).toBe("");
	});

	test("a note's headings cannot end the transcript section it is imported into", () => {
		const note = "앞부분\n\n## 안건\n안건 내용\n\n# 결론\n결론 내용";
		const t = appendToSection(appendToSection(session, "오디오", "![[a/001.webm]]"), "받아쓰기", transcriptFromNote(note));
		const transcript = extractSection(t, "받아쓰기");
		for (const text of ["앞부분", "안건 내용", "결론 내용"]) expect(transcript).toContain(text);
		expect(extractSection(t, "오디오")).toBe("![[a/001.webm]]");
	});

	test("demoteHeadings lowers only top-level headings", () => {
		expect(demoteHeadings("# a\n## b\n### c\n#태그\n본문 # d")).toBe("#### a\n##### b\n### c\n#태그\n본문 # d");
	});

	test("import heading carries the marker of its own source only", () => {
		const heading = importHeading("2026-11-03 14:10", "폴더/녹음.m4a");
		expect(heading).toBe("### 2026-11-03 14:10 · 가져오기 · [[폴더/녹음.m4a]]");
		expect(heading).toContain(importMarker("폴더/녹음.m4a"));
		expect(heading).not.toContain(importMarker("녹음.m4a"));
	});

	test("model suggestions list everything for a complete name and filter otherwise", () => {
		const models = ["gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-sol"];
		expect(modelSuggestions(models, "gpt-6.1-sol")).toEqual(models);
		expect(modelSuggestions(models, "")).toEqual(models);
		expect(modelSuggestions(models, "SOL")).toEqual(["gpt-6.1-sol", "gpt-5.6-sol"]);
	});

	test("callout omits an unknown duration", () => {
		expect(renderCallout("세션", 3)).toContain("[[세션|세션]] · 3분\n");
		expect(renderCallout("세션", 0)).toContain("[[세션|세션]]\n");
	});

	test("stripMarkers removes plugin markers only", () => {
		expect(stripMarkers(`a\n${pendingMarker("1")}\n\n\nb %% keep %%`)).toBe("a\n\nb %% keep %%");
	});
});

describe("extractLinks", () => {
	test("wiki, embeds, markdown links and bare URLs", () => {
		const links = extractLinks(
			"[[A]] ![[B#H|alias]] [t](C.md) [u](<D E.md>) [w](https://x.com/a) https://y.com/b. [[A]] [m](mailto:a@b) [h](#local)",
		);
		expect(links.internal).toEqual(["A", "B#H", "C.md", "D E.md"]);
		expect(links.urls).toEqual(["https://x.com/a", "https://y.com/b"]);
	});
});

describe("blocks", () => {
	const callout = renderCallout("Recordings/s", 12);
	const note = `intro\n${renderBlock("1", "### 정리\n- a", callout)}\noutro`;

	test("findBlock separates summary body from callout", () => {
		const b = findBlock(note, "1")!;
		expect(note.slice(b.bodyFrom, b.bodyTo)).toBe("### 정리\n- a\n\n");
		expect(note.slice(b.from, b.to).endsWith(END_MARKER)).toBe(true);
		expect(findBlock(note, "2")).toBeNull();
	});

	test("a blank line keeps the callout out of the last list item", () => {
		const lines = renderBlock("1", "### 정리\n- a", callout).split("\n");
		expect(lines[lines.findIndex((l) => l.startsWith("> [!quote]")) - 1]).toBe("");
		expect(lines[lines.findIndex((l) => l.startsWith("> [!quote]")) - 2]).toBe("- a");
		expect(renderBlock("1", "- a", null)).toBe(`${startMarker("1")}\n- a\n${END_MARKER}`);
	});

	test("blockIdAt finds blocks and pending markers", () => {
		const t = `${note}\n${pendingMarker("9")}`;
		expect(blockIdAt(t, t.indexOf("- a"))).toBe("1");
		expect(blockIdAt(t, t.indexOf(pendingMarker("9")) + 3)).toBe("9");
		expect(blockIdAt(t, 0)).toBeNull();
	});

	test("findPending matches whole lines only", () => {
		expect(findPending(`x ${pendingMarker("1")}`, "1")).toBeNull();
		expect(findPending(`x\n${pendingMarker("1")}`, "1")).toEqual({ from: 2, to: 2 + pendingMarker("1").length });
		expect(startMarker("1")).toBe("%% voice-context:start 1 %%");
	});
});

describe("insertions", () => {
	const body = "### 정리\n- 핵심\n  - 세부\n- 할 일";

	test("numberLines", () => {
		expect(numberLines("a\nb")).toBe("1| a\n2| b");
	});

	test("parse tolerates fences, prose and echoed numbers", () => {
		const out = 'Here:\n```json\n{"insertions":[{"after_line":2,"text":"3| - 새 항목\\n"},{"after_line":"x","text":"bad"},{"after_line":1,"text":"  "}]}\n```';
		expect(parseInsertions(out)).toEqual([{ afterLine: 2, text: "- 새 항목" }]);
		expect(() => parseInsertions("no json")).toThrow();
	});

	test("siblings skip nested children; children stay attached", () => {
		expect(applyInsertions(body, [{ afterLine: 2, text: "- 형제" }])).toBe("### 정리\n- 핵심\n  - 세부\n- 형제\n- 할 일");
		expect(applyInsertions(body, [{ afterLine: 2, text: "  - 자식" }])).toBe("### 정리\n- 핵심\n  - 자식\n  - 세부\n- 할 일");
	});

	test("same anchor keeps order, out-of-range clamps, existing lines untouched", () => {
		const result = applyInsertions(body, [
			{ afterLine: 4, text: "- x" },
			{ afterLine: 99, text: "- y" },
			{ afterLine: 0, text: "맨 앞" },
		]);
		expect(result).toBe("맨 앞\n### 정리\n- 핵심\n  - 세부\n- 할 일\n- x\n- y");
		for (const line of body.split("\n")) expect(result.split("\n")).toContain(line);
	});
});

test("diffRange yields the minimal replacement", () => {
	const a = "hello world";
	const b = "hello brave world";
	const d = diffRange(a, b);
	expect(d).toEqual({ from: 6, to: 6, text: "brave " });
	expect(a.slice(0, d.from) + d.text + a.slice(d.to)).toBe(b);
	expect(diffRange("same", "same")).toEqual({ from: 4, to: 4, text: "" });
});

describe("removeSegmentLines", () => {
	const a = "R/s/001.webm";
	const b = "R/s/002.webm";
	const isB = (link: string) => link === b;

	test("drops the embed and failed marker, keeping transcript and neighbors", () => {
		const text = `## 받아쓰기\n\n말\n\n%% voice-context:failed ${b} %%\n\n## 오디오\n\n![[${a}]]\n\n![[${b}]]\n\n%% voice-context:start x %%\n`;
		expect(removeSegmentLines(text, b, isB)).toBe(`## 받아쓰기\n\n말\n\n## 오디오\n\n![[${a}]]\n\n%% voice-context:start x %%\n`);
	});

	test("handles a last line, subpaths and aliases", () => {
		expect(removeSegmentLines(`## 오디오\n\n![[${b}]]\n`, b, isB)).toBe("## 오디오\n");
		expect(removeSegmentLines(`![[${b}#t=3]]\n![[${b}|x]]`, b, isB)).toBe("");
	});

	test("leaves inline mentions and other embeds alone", () => {
		const text = `참고 ![[${b}]] 끝\n\n![[${a}]]\n`;
		expect(removeSegmentLines(text, b, isB)).toBe(text);
	});
});
