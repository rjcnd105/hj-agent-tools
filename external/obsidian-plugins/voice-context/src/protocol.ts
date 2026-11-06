// Pure wire-format helpers. No `obsidian` import so the test runner can load this module.

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
		readonly param?: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export function apiErrorFrom(status: number, body: string): ApiError {
	try {
		const data = JSON.parse(body) as {
			error?: string | { message?: string; code?: string; type?: string; param?: string };
			error_description?: string;
			code?: unknown;
			message?: unknown;
			innerError?: { code?: unknown };
		};
		if (typeof data.error === "string") return new ApiError(data.error_description ?? data.error, status, data.error);
		if (data.error) return new ApiError(data.error.message ?? `HTTP ${status}`, status, data.error.code ?? data.error.type, data.error.param);
		// Azure Speech reports errors at the top level.
		if (typeof data.message === "string") return new ApiError(data.message, status, String(data.innerError?.code ?? data.code ?? "") || undefined);
	} catch {
		// Not JSON; fall through.
	}
	return new ApiError(body.slice(0, 200) || `HTTP ${status}`, status);
}

interface ResponseOutput {
	output?: { type?: string; content?: { type?: string; text?: string }[] }[];
}

const outputText = (response: ResponseOutput) =>
	(response.output ?? [])
		.flatMap((item) => item.content ?? [])
		.filter((c) => c.type === "output_text")
		.map((c) => c.text ?? "")
		.join("");

/** Collect the text of a Responses API SSE body. `response.completed` is the only success signal. */
export function parseResponseStream(body: string): string {
	let text = "";
	let completed: ResponseOutput | null = null;
	for (const block of body.split(/\r?\n\r?\n/)) {
		const data = block
			.split(/\r?\n/)
			.filter((l) => l.startsWith("data:"))
			.map((l) => l.slice(5).trimStart())
			.join("\n");
		if (!data || data === "[DONE]") continue;
		let ev: Record<string, any>;
		try {
			ev = JSON.parse(data);
		} catch {
			continue;
		}
		switch (ev.type) {
			case "response.output_text.delta":
				text += ev.delta ?? "";
				break;
			case "response.completed":
				completed = ev.response ?? {};
				break;
			case "response.failed": {
				const e = ev.response?.error;
				throw new ApiError(e?.message ?? "응답 생성에 실패했습니다", 0, e?.code);
			}
			case "response.incomplete":
				throw new ApiError(`응답이 중단되었습니다 (${ev.response?.incomplete_details?.reason ?? "unknown"})`, 0, "response_incomplete");
			case "error": {
				const e = ev.error ?? ev;
				throw new ApiError(e.message ?? "스트림 오류", 0, e.code, e.param);
			}
		}
	}
	if (!completed) throw new ApiError("응답이 완료되지 않았습니다", 0, "stream_incomplete");
	return text || outputText(completed);
}

const encoder = new TextEncoder();

export function buildMultipart(
	fields: [string, string][],
	file: { name: string; type: string; data: ArrayBuffer },
	fileField = "file",
): { body: ArrayBuffer; contentType: string } {
	const boundary = `----voicecontext${randomToken(12)}`;
	const parts: Uint8Array[] = [];
	for (const [name, value] of fields) {
		parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
	}
	parts.push(
		encoder.encode(
			`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${file.name}"\r\nContent-Type: ${file.type.split(";")[0]}\r\n\r\n`,
		),
		new Uint8Array(file.data),
		encoder.encode(`\r\n--${boundary}--\r\n`),
	);
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return { body: out.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}

export function transcriptionFields({
	model,
	prompt,
	languages,
}: {
	model: string;
	prompt: string;
	languages: string[];
}): [string, string][] {
	const fields: [string, string][] = [["model", model]];
	if (prompt && !model.includes("diarize")) fields.push(["prompt", prompt]);
	if (model.startsWith("gpt-transcribe")) {
		for (const language of languages) fields.push(["languages[]", language]);
	} else if (languages[0]) {
		fields.push(["language", languages[0]]);
	}
	return fields;
}

const AZURE_API_VERSION = "2025-10-15";

/** Accepts a resource name or the full endpoint shown in the Azure portal. */
export function azureTranscribeUrl(endpointOrResource: string): string {
	const value = endpointOrResource.trim().replace(/\/+$/, "");
	const base = /^https?:\/\//.test(value) ? value : `https://${value}.cognitiveservices.azure.com`;
	return `${base}/speechtotext/transcriptions:transcribe?api-version=${AZURE_API_VERSION}`;
}

export type TranscribeStyle = "verbatim" | "clean";

/** `locales` takes one value for MAI-Transcribe; leaving it out asks for auto-detection. Phrases are recognition hints, not forced output. */
export const azureDefinition = (model: string, language: string | undefined, style: TranscribeStyle, phrases: string[]) =>
	JSON.stringify({
		...(language ? { locales: [language] } : {}),
		enhancedMode: { enabled: true, model, modelOptions: { transcribeStyle: style } },
		...(phrases.length ? { phraseList: { phrases } } : {}),
	});

/** Null when the response has no transcript field. Silence comes back as no phrases, which is an empty transcript. */
export function azureTranscript(response: unknown): string | null {
	const combined = (response as { combinedPhrases?: { text?: unknown }[] } | null)?.combinedPhrases;
	if (!Array.isArray(combined)) return null;
	const text = combined[0]?.text;
	return typeof text === "string" ? text.trim() : "";
}

/** Audio length the service reports, or 0 when the response has none. */
export function azureDurationMs(response: unknown): number {
	const ms = (response as { durationMilliseconds?: unknown } | null)?.durationMilliseconds;
	return typeof ms === "number" && ms > 0 ? ms : 0;
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
	const out = new ArrayBuffer(44 + samples.length * 2);
	const view = new DataView(out);
	const ascii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};
	ascii(0, "RIFF");
	view.setUint32(4, 36 + samples.length * 2, true);
	ascii(8, "WAVEfmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	ascii(36, "data");
	view.setUint32(40, samples.length * 2, true);
	for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), true);
	return out;
}

// ChatGPT tokens reject a plain string with `Input must be a list`; API keys accept both.
export const responsesBody = (model: string, instructions: string, input: string) =>
	JSON.stringify({ model, instructions, input: [{ role: "user", content: [{ type: "input_text", text: input }] }], store: false, stream: true });

export const splitList = (s: string) =>
	s
		.split(/[,\n]/)
		.map((x) => x.trim())
		.filter(Boolean);

export class Cancelled extends Error {
	override name = "Cancelled";
}

export function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

const NO_RETRY = new Set([
	"insufficient_quota",
	"subscription_sharing_usage_limit_exceeded",
	"subscription_sharing_user_not_eligible",
	"subscription_sharing_unsupported_capability",
	"subscription_sharing_route_not_supported",
	"subscription_sharing_invalid_user",
]);

export async function withRetry<T>(fn: () => Promise<T>, signal: AbortSignal, retries = 2): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		signal.throwIfAborted();
		try {
			// `requestUrl` cannot be aborted, so a cancel abandons the request rather than stopping it.
			return await cancellable(fn(), signal);
		} catch (e) {
			const retryable = !(e instanceof Cancelled) && (!(e instanceof ApiError) || (!NO_RETRY.has(e.code ?? "") && (e.status === 429 || e.status >= 500)));
			if (!retryable || attempt >= retries) throw e;
			await cancellable(new Promise((r) => setTimeout(r, 1000 * 3 ** attempt)), signal);
		}
	}
}

export function base64url(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const randomToken = (bytes = 32) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

export async function pkceChallenge(verifier: string): Promise<string> {
	return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
}

export function decodeJwt(token: string): Record<string, unknown> {
	const part = token.split(".")[1];
	if (!part) throw new Error("JWT 형식이 아닙니다");
	const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
	const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
	return JSON.parse(new TextDecoder().decode(bytes));
}
