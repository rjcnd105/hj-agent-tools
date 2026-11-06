// Pure phrase-preset rules. No `obsidian` import so the test runner can load this module.
import { splitList } from "./protocol";

export interface PhrasePreset {
	name: string;
	phrases: string[];
}

/** What the agent judged about one session. A null preset means no preset fits. */
export interface PresetDecision {
	preset: string | null;
	add: string[];
	remove: string[];
	retranscribe: boolean;
	reason: string;
}

export interface PresetPlan {
	presets: PhrasePreset[];
	target: PhrasePreset;
	isNew: boolean;
	added: string[];
	removed: string[];
}

export const parsePhrases = (text: string) => [...new Set(splitList(text))];

const phraseArray = (value: unknown) => (Array.isArray(value) ? parsePhrases(value.filter((v): v is string => typeof v === "string").join("\n")) : []);

export function parsePresetDecision(output: string): PresetDecision {
	const start = output.indexOf("{");
	const end = output.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error("프리셋 판단 응답에서 JSON을 찾지 못했습니다");
	const data = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
	const reason = typeof data.reason === "string" ? data.reason.trim() : "";
	const preset = typeof data.preset === "string" ? data.preset.replace(/\s+/g, " ").trim() : "";
	if (!preset) return { preset: null, add: [], remove: [], retranscribe: false, reason };
	return { preset, add: phraseArray(data.add), remove: phraseArray(data.remove), retranscribe: data.retranscribe === true, reason };
}

/** Null when the decision names no preset, or a new one with nothing in it. Added phrases win over removed ones. */
export function planPreset(presets: PhrasePreset[], decision: PresetDecision): PresetPlan | null {
	if (!decision.preset) return null;
	const existing = presets.find((p) => p.name === decision.preset);
	if (!existing && !decision.add.length) return null;
	const before = existing?.phrases ?? [];
	const added = decision.add.filter((p) => !before.includes(p));
	const removed = decision.remove.filter((p) => before.includes(p) && !decision.add.includes(p));
	const target = { name: decision.preset, phrases: [...before.filter((p) => !removed.includes(p)), ...added] };
	return { presets: existing ? presets.map((p) => (p === existing ? target : p)) : [...presets, target], target, isNew: !existing, added, removed };
}
