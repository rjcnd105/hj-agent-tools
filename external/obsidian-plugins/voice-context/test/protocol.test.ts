import { describe, expect, test } from "bun:test";
import {
	ApiError,
	Cancelled,
	apiErrorFrom,
	azureDefinition,
	azureDurationMs,
	azureTranscribeUrl,
	azureTranscript,
	base64url,
	buildMultipart,
	cancellable,
	decodeJwt,
	encodeWav,
	parseResponseStream,
	pkceChallenge,
	responsesBody,
	splitList,
	transcriptionFields,
	withRetry,
} from "../src/protocol";

const sse = (...events: object[]) => events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");

describe("parseResponseStream", () => {
	test("joins deltas and requires response.completed", () => {
		const body = sse(
			{ type: "response.created" },
			{ type: "response.output_text.delta", delta: "안녕" },
			{ type: "response.output_text.delta", delta: "하세요" },
			{ type: "response.completed", response: {} },
		);
		expect(parseResponseStream(body)).toBe("안녕하세요");
		expect(() => parseResponseStream(sse({ type: "response.output_text.delta", delta: "a" }))).toThrow("완료되지");
	});

	test("falls back to completed output text", () => {
		const response = { output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] };
		expect(parseResponseStream(sse({ type: "response.completed", response }))).toBe("done");
	});

	test("surfaces failure codes", () => {
		const failed = sse({
			type: "response.failed",
			response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } },
		});
		try {
			parseResponseStream(failed);
			throw new Error("unreachable");
		} catch (e) {
			expect(e).toBeInstanceOf(ApiError);
			expect((e as ApiError).code).toBe("subscription_sharing_usage_limit_exceeded");
		}
		expect(() => parseResponseStream(sse({ type: "error", code: "x", message: "boom" }))).toThrow("boom");
	});
});

test("apiErrorFrom handles OpenAI and OAuth shapes", () => {
	const a = apiErrorFrom(429, JSON.stringify({ error: { message: "m", code: "c", param: "p" } }));
	expect([a.status, a.code, a.param, a.message]).toEqual([429, "c", "p", "m"]);
	const b = apiErrorFrom(400, JSON.stringify({ error: "invalid_grant", error_description: "expired" }));
	expect([b.code, b.message]).toEqual(["invalid_grant", "expired"]);
	expect(apiErrorFrom(502, "<html>").message).toBe("<html>");
});

test("buildMultipart produces a parseable form", async () => {
	const audio = new Uint8Array([0, 1, 2, 255]).buffer;
	const { body, contentType } = buildMultipart(
		[
			["model", "gpt-transcribe"],
			["prompt", "이전 문맥"],
		],
		{ name: "001.webm", type: "audio/webm;codecs=opus", data: audio },
	);
	const form = await new Response(body, { headers: { "Content-Type": contentType } }).formData();
	expect(form.get("model")).toBe("gpt-transcribe");
	expect(form.get("prompt")).toBe("이전 문맥");
	const file = form.get("file") as File;
	expect(file.name).toBe("001.webm");
	expect(new TextDecoder().decode(body)).toContain("Content-Type: audio/webm\r\n");
	expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([0, 1, 2, 255]);
});

describe("transcriptionFields", () => {
	const parse = (fields: [string, string][]) => {
		const { body, contentType } = buildMultipart(fields, { name: "a.webm", type: "audio/webm", data: new ArrayBuffer(1) });
		return new Response(body, { headers: { "Content-Type": contentType } }).formData();
	};
	const input = { prompt: "이전 문맥", languages: ["ko", "en"] };

	test("gpt-transcribe sends every language", async () => {
		const form = await parse(transcriptionFields({ model: "gpt-transcribe", ...input }));
		expect(form.get("model")).toBe("gpt-transcribe");
		expect(form.get("prompt")).toBe("이전 문맥");
		expect(form.getAll("languages[]")).toEqual(["ko", "en"]);
		expect(form.has("language")).toBe(false);
	});

	test("whisper-1 sends the first language", async () => {
		const form = await parse(transcriptionFields({ model: "whisper-1", ...input }));
		expect(form.get("prompt")).toBe("이전 문맥");
		expect(form.getAll("language")).toEqual(["ko"]);
		expect(form.has("languages[]")).toBe(false);
	});

	test("a diarize model sends no prompt", async () => {
		const form = await parse(transcriptionFields({ model: "gpt-4o-transcribe-diarize", ...input }));
		expect(form.has("prompt")).toBe(false);
		expect(form.getAll("language")).toEqual(["ko"]);
	});

	test("empty inputs produce only the model", () => {
		for (const model of ["gpt-transcribe", "whisper-1"]) {
			expect(transcriptionFields({ model, prompt: "", languages: [] })).toEqual([["model", model]]);
		}
	});
});

test("splitList accepts commas and newlines and drops blanks", () => {
	expect(splitList(" ko, en\n\nja ,")).toEqual(["ko", "en", "ja"]);
	expect(splitList("")).toEqual([]);
});

test("responsesBody sends a list input without storing", () => {
	expect(JSON.parse(responsesBody("m", "지시", "입력"))).toEqual({
		model: "m",
		instructions: "지시",
		input: [{ role: "user", content: [{ type: "input_text", text: "입력" }] }],
		store: false,
		stream: true,
	});
});

describe("cancellation", () => {
	const never = () => new Promise<never>(() => {});
	const cancelled = () => new Cancelled("취소");

	test("cancellable rejects at once for an already aborted signal", async () => {
		const controller = new AbortController();
		controller.abort(cancelled());
		await expect(cancellable(never(), controller.signal)).rejects.toBeInstanceOf(Cancelled);
	});

	test("cancellable passes through a result when not aborted", async () => {
		expect(await cancellable(Promise.resolve("ok"), new AbortController().signal)).toBe("ok");
	});

	test("withRetry rejects a hung attempt right after abort", async () => {
		const controller = new AbortController();
		const pending = withRetry(never, controller.signal);
		controller.abort(cancelled());
		await expect(pending).rejects.toBeInstanceOf(Cancelled);
	});

	test("withRetry does not start an attempt on an aborted signal", async () => {
		const controller = new AbortController();
		controller.abort(cancelled());
		let calls = 0;
		await expect(withRetry(async () => void calls++, controller.signal)).rejects.toBeInstanceOf(Cancelled);
		expect(calls).toBe(0);
	});

	test("abort during backoff stops further attempts without waiting out the delay", async () => {
		const controller = new AbortController();
		let calls = 0;
		const started = performance.now();
		const pending = withRetry(async () => {
			calls++;
			setTimeout(() => controller.abort(cancelled()));
			throw new ApiError("서버 오류", 500);
		}, controller.signal);
		await expect(pending).rejects.toBeInstanceOf(Cancelled);
		expect(calls).toBe(1);
		expect(performance.now() - started).toBeLessThan(500);
	});

	test("withRetry retries a 500", async () => {
		let calls = 0;
		const result = await withRetry(
			async () => {
				if (++calls === 1) throw new ApiError("서버 오류", 500);
				return "ok";
			},
			new AbortController().signal,
			1,
		);
		expect([result, calls]).toEqual(["ok", 2]);
	});

	test.each([
		["a 401", new ApiError("키 오류", 401)],
		["an exhausted quota", new ApiError("한도", 429, "insufficient_quota")],
		["a Cancelled thrown by the attempt", cancelled()],
	])("withRetry does not retry %s", async (_label, error) => {
		let calls = 0;
		const attempt = async () => {
			calls++;
			throw error;
		};
		await expect(withRetry(attempt, new AbortController().signal)).rejects.toBe(error);
		expect(calls).toBe(1);
	});
});

test("PKCE S256 challenge is base64url(sha256(verifier))", async () => {
	// Expected value from: printf %s <verifier> | openssl dgst -sha256 -binary | base64url
	expect(await pkceChallenge("dBjftJeZ4CVP-mJ92K1qUPXuJOsGH4LhbB4e4MDSuu8")).toBe("DjS3yVfhnTV_6RDIW07U44n0owHUrJThlWEb3j4VgeE");
	expect(base64url(new Uint8Array([251, 255]))).toBe("-_8");
});

test("decodeJwt reads UTF-8 payloads", () => {
	const payload = base64url(new TextEncoder().encode(JSON.stringify({ email: "a@b.c", name: "홍길동", nonce: "n" })));
	expect(decodeJwt(`h.${payload}.s`)).toEqual({ email: "a@b.c", name: "홍길동", nonce: "n" });
});

describe("azure", () => {
	const url = "speechtotext/transcriptions:transcribe?api-version=2025-10-15";

	test("takes a resource name or a full endpoint", () => {
		expect(azureTranscribeUrl(" my-res ")).toBe(`https://my-res.cognitiveservices.azure.com/${url}`);
		expect(azureTranscribeUrl("https://westus.api.cognitive.microsoft.com/")).toBe(`https://westus.api.cognitive.microsoft.com/${url}`);
	});

	test("definition selects the model and an optional locale", () => {
		const enhancedMode = { enabled: true, model: "MAI-Transcribe-2", modelOptions: { transcribeStyle: "clean" } };
		expect(JSON.parse(azureDefinition("MAI-Transcribe-2", "ko", "clean", []))).toEqual({ locales: ["ko"], enhancedMode });
		expect(JSON.parse(azureDefinition("MAI-Transcribe-2", undefined, "clean", ["용어"]))).toEqual({ enhancedMode, phraseList: { phrases: ["용어"] } });
	});

	test("reads the first channel and treats silence as empty", () => {
		expect(azureDurationMs({ durationMilliseconds: 6980 })).toBe(6980);
		expect(azureDurationMs({ combinedPhrases: [] })).toBe(0);
		expect(azureTranscript({ combinedPhrases: [{ text: " 안녕 " }] })).toBe("안녕");
		expect(azureTranscript({ combinedPhrases: [] })).toBe("");
		expect(azureTranscript({})).toBeNull();
	});

	test("parses top-level errors without changing OpenAI's shape", () => {
		const e = apiErrorFrom(400, JSON.stringify({ code: "InvalidRequest", message: "bad audio", innerError: { code: "InvalidAudioFormat" } }));
		expect([e.message, e.code]).toEqual(["bad audio", "InvalidAudioFormat"]);
		expect(apiErrorFrom(401, JSON.stringify({ error: { code: "401", message: "denied" } })).message).toBe("denied");
	});

	test("multipart file field is configurable", () => {
		const { body } = buildMultipart([["definition", "{}"]], { name: "a.wav", type: "audio/wav", data: new ArrayBuffer(1) }, "audio");
		expect(new TextDecoder().decode(body)).toContain('name="audio"; filename="a.wav"');
	});

	test("encodes clamped 16-bit mono WAV", () => {
		const view = new DataView(encodeWav(new Float32Array([0, 2, -2]), 16000));
		const ascii = (from: number, n: number) => String.fromCharCode(...Array.from({ length: n }, (_, i) => view.getUint8(from + i)));
		expect([ascii(0, 4), ascii(8, 4), ascii(36, 4)]).toEqual(["RIFF", "WAVE", "data"]);
		expect([view.getUint16(22, true), view.getUint32(24, true), view.getUint32(40, true)]).toEqual([1, 16000, 6]);
		expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)]).toEqual([0, 32767, -32767]);
	});
});
