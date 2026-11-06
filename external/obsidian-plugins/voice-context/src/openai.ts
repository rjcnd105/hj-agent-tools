import { requestUrl } from "obsidian";
import { ApiError, apiErrorFrom, buildMultipart, parseResponseStream, responsesBody } from "./protocol";

const API = "https://api.openai.com/v1";

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function transcribe(apiKey: string, audio: ArrayBuffer, fileName: string, mimeType: string, fields: [string, string][]): Promise<string> {
	const { body, contentType } = buildMultipart(fields, { name: fileName, type: mimeType, data: audio });
	const res = await requestUrl({ url: `${API}/audio/transcriptions`, method: "POST", contentType, headers: auth(apiKey), body, throw: false });
	if (res.status >= 400) throw apiErrorFrom(res.status, res.text);
	const text: unknown = res.json?.text;
	// Silence legitimately comes back as `{"text": ""}`.
	if (typeof text !== "string") throw new ApiError("받아쓰기 응답에 text가 없습니다", res.status);
	return text.trim();
}

/** Responses API call that also satisfies the Sign in with ChatGPT constraints (store:false, stream:true, no sampling params). */
export async function generate(token: string, model: string, instructions: string, input: string): Promise<string> {
	const res = await requestUrl({
		url: `${API}/responses`,
		method: "POST",
		contentType: "application/json",
		headers: { ...auth(token), Accept: "text/event-stream" },
		body: responsesBody(model, instructions, input),
		throw: false,
	});
	if (res.status >= 400) throw apiErrorFrom(res.status, res.text);
	return parseResponseStream(res.text);
}

/** API keys return `{data:[{id}]}`; ChatGPT tokens return `{models:[{slug, visibility}]}`. */
export async function listModels(token: string): Promise<string[]> {
	const res = await requestUrl({ url: `${API}/models`, headers: auth(token), throw: false });
	if (res.status >= 400) throw apiErrorFrom(res.status, res.text);
	const data = res.json as { data?: { id: string }[]; models?: { slug: string; visibility?: string }[] };
	if (Array.isArray(data.models)) return data.models.filter((m) => !m.visibility || m.visibility === "list").map((m) => m.slug);
	return (data.data ?? []).map((m) => m.id).sort();
}

export function explainError(e: unknown): string {
	if (e instanceof ApiError) {
		switch (e.code) {
			case "subscription_sharing_usage_limit_exceeded":
				return "ChatGPT 구독 사용 한도에 도달했습니다. ChatGPT 설정 → 사용량에서 확인하거나, 구독 공유에 크레딧 사용을 켜세요.";
			case "subscription_sharing_usage_unavailable":
				return "ChatGPT 사용량 서비스를 일시적으로 쓸 수 없습니다. 잠시 후 다시 시도하세요.";
			case "subscription_sharing_user_not_eligible":
				return "이 ChatGPT 계정은 구독 공유를 사용할 수 없습니다.";
			case "subscription_sharing_unsupported_capability":
				return `ChatGPT 구독으로 지원하지 않는 요청입니다${e.param ? ` (${e.param})` : ""}.`;
			case "subscription_sharing_invalid_user":
				return "ChatGPT 인증 정보가 올바르지 않습니다. 설정에서 다시 로그인하세요.";
			case "insufficient_quota":
				return "OpenAI API 크레딧이 부족합니다.";
			case "invalid_api_key":
				return "OpenAI API 키가 올바르지 않습니다.";
		}
		return e.code ? `${e.message} (${e.code})` : e.message;
	}
	return e instanceof Error ? e.message : String(e);
}
