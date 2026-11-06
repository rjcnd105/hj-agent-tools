import { describe, expect, test } from "bun:test";
import { type PresetDecision, parsePhrases, parsePresetDecision, planPreset } from "../src/presets";

const decision = (over: Partial<PresetDecision>): PresetDecision => ({ preset: "회의", add: [], remove: [], retranscribe: false, reason: "", ...over });

describe("parsePresetDecision", () => {
	test("reads JSON wrapped in prose and cleans phrases", () => {
		const output = '판단:\n```json\n{"preset":" 회의\\n이름 ","add":[" 마르지엘라 ","마르지엘라",1,""],"remove":["틀림"],"retranscribe":true,"reason":" 근거 "}\n```';
		expect(parsePresetDecision(output)).toEqual({ preset: "회의 이름", add: ["마르지엘라"], remove: ["틀림"], retranscribe: true, reason: "근거" });
	});

	test("a null preset cannot carry edits or a re-transcription", () => {
		expect(parsePresetDecision('{"preset":null,"add":["x"],"retranscribe":true,"reason":"무관"}')).toEqual({ preset: null, add: [], remove: [], retranscribe: false, reason: "무관" });
	});

	test("only a literal true re-transcribes", () => {
		expect(parsePresetDecision('{"preset":"회의","retranscribe":"true"}').retranscribe).toBe(false);
	});

	test("rejects output without JSON", () => {
		expect(() => parsePresetDecision("모르겠습니다")).toThrow("JSON");
	});
});

describe("planPreset", () => {
	const presets = [
		{ name: "회의", phrases: ["가", "나"] },
		{ name: "다른", phrases: ["다"] },
	];

	test("edits only the named preset and reports real changes", () => {
		const plan = planPreset(presets, decision({ add: ["가", "라"], remove: ["나", "없음"] }))!;
		expect(plan.presets).toEqual([{ name: "회의", phrases: ["가", "라"] }, presets[1]!]);
		expect([plan.added, plan.removed, plan.isNew]).toEqual([["라"], ["나"], false]);
		expect(presets[0]!.phrases).toEqual(["가", "나"]);
	});

	test("an added phrase wins over the same removal", () => {
		const plan = planPreset(presets, decision({ add: ["가"], remove: ["가"] }))!;
		expect(plan.target.phrases).toEqual(["가", "나"]);
		expect(plan.removed).toEqual([]);
	});

	test("creates a new preset only when it has phrases", () => {
		expect(planPreset(presets, decision({ preset: "새것", add: ["라"] }))?.isNew).toBe(true);
		expect(planPreset(presets, decision({ preset: "새것" }))).toBeNull();
		expect(planPreset(presets, decision({ preset: null }))).toBeNull();
	});
});

test("parsePhrases splits on lines and commas and drops duplicates", () => {
	expect(parsePhrases("가, 나\n\n가\n 다 ")).toEqual(["가", "나", "다"]);
});
