import { requestUrl } from "obsidian";
import { ApiError, type TranscribeStyle, apiErrorFrom, azureDefinition, azureDurationMs, azureTranscribeUrl, azureTranscript, buildMultipart, encodeWav } from "./protocol";

export interface AudioUpload {
	name: string;
	type: string;
	data: ArrayBuffer;
}

/** Matches the 16 kHz mono input MAI-Transcribe-2 was benchmarked on. */
const SAMPLE_RATE = 16_000;

/**
 * The MAI-Transcribe page lists only WAV, MP3 and FLAC, while the recorder produces WebM or M4A.
 * Those two are decoded here and uploaded as WAV.
 */
export async function maiAudio(data: ArrayBuffer, name: string, type: string): Promise<AudioUpload> {
	if (/\.(wav|mp3)$/i.test(name)) return { name, type, data };
	// decodeAudioData detaches its input and resamples to the context's rate.
	const decoded = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(data.slice(0));
	const mono = new Float32Array(decoded.length);
	for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
		const samples = decoded.getChannelData(channel);
		for (let i = 0; i < mono.length; i++) mono[i]! += samples[i]! / decoded.numberOfChannels;
	}
	return { name: `${name.replace(/\.[^.]+$/, "")}.wav`, type: "audio/wav", data: encodeWav(mono, SAMPLE_RATE) };
}

export async function transcribeAzure(
	endpoint: string,
	key: string,
	model: string,
	language: string | undefined,
	style: TranscribeStyle,
	phrases: string[],
	audio: AudioUpload,
): Promise<{ text: string; durationMs: number }> {
	const { body, contentType } = buildMultipart([["definition", azureDefinition(model, language, style, phrases)]], audio, "audio");
	const res = await requestUrl({ url: azureTranscribeUrl(endpoint), method: "POST", contentType, headers: { "Ocp-Apim-Subscription-Key": key }, body, throw: false });
	if (res.status >= 400) throw apiErrorFrom(res.status, res.text);
	const text = azureTranscript(res.json);
	if (text === null) throw new ApiError("받아쓰기 응답에 combinedPhrases가 없습니다", res.status);
	return { text, durationMs: azureDurationMs(res.json) };
}
