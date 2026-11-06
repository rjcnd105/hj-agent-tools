export interface Segment {
	index: number;
	blob: Blob;
	mimeType: string;
	durationMs: number;
}

const MIME_TYPES = ["audio/webm;codecs=opus", "audio/mp4"];
const BITS_PER_SECOND = 32_000;

export const openMicrophone = () =>
	navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });

interface Current {
	rec: MediaRecorder;
	startedAt: number;
	durationMs: number;
}

/**
 * Records one stream as consecutive standalone files. Each segment is a fresh MediaRecorder,
 * so memory holds at most one segment and every file can be transcribed on its own.
 * Rotation counts active time only; paused time is excluded.
 */
export class SegmentRecorder {
	state: "inactive" | "recording" | "paused" = "inactive";
	private current: Current | null = null;
	private pending = new Set<Promise<void>>();
	private activeMs = 0;
	private resumedAt = 0;
	private timer = 0;

	constructor(
		private readonly stream: MediaStream,
		private readonly segmentMs: number,
		private nextIndex: number,
		private readonly onSegment: (segment: Segment) => void,
		private readonly onEnded: () => void,
	) {}

	get elapsedMs() {
		return this.activeMs + (this.state === "recording" ? performance.now() - this.resumedAt : 0);
	}

	start() {
		this.stream.getAudioTracks()[0]?.addEventListener("ended", this.onEnded);
		this.state = "recording";
		this.resumedAt = performance.now();
		this.beginSegment();
		this.schedule();
	}

	pause() {
		if (this.state !== "recording") return;
		this.current?.rec.pause();
		this.activeMs += performance.now() - this.resumedAt;
		this.state = "paused";
		window.clearTimeout(this.timer);
	}

	resume() {
		if (this.state !== "paused") return;
		this.current?.rec.resume();
		this.resumedAt = performance.now();
		this.state = "recording";
		this.schedule();
	}

	/** Flushes the last segment and resolves once every `onSegment` call has happened. */
	async stop() {
		if (this.state === "inactive") return;
		window.clearTimeout(this.timer);
		if (this.state === "recording") this.activeMs += performance.now() - this.resumedAt;
		this.state = "inactive";
		this.endSegment(this.current);
		this.current = null;
		await Promise.all(this.pending);
		this.stream.getAudioTracks()[0]?.removeEventListener("ended", this.onEnded);
		for (const track of this.stream.getTracks()) track.stop();
	}

	private schedule() {
		window.clearTimeout(this.timer);
		const remaining = this.segmentMs - (this.elapsedMs - (this.current?.startedAt ?? 0));
		this.timer = window.setTimeout(() => this.rotate(), Math.max(0, remaining));
	}

	private rotate() {
		if (this.state !== "recording") return;
		const old = this.current;
		// Start the next recorder before stopping the old one so no audio falls in the gap.
		this.beginSegment();
		this.endSegment(old);
		this.schedule();
	}

	private beginSegment() {
		const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
		const rec = new MediaRecorder(this.stream, { mimeType, audioBitsPerSecond: BITS_PER_SECOND });
		const chunks: Blob[] = [];
		const current: Current = { rec, startedAt: this.elapsedMs, durationMs: 0 };
		const index = this.nextIndex++;
		rec.ondataavailable = (e) => {
			if (e.data.size) chunks.push(e.data);
		};
		const done = new Promise<void>((resolve) => {
			rec.onstop = () => {
				const type = rec.mimeType || mimeType || "audio/webm";
				this.onSegment({ index, blob: new Blob(chunks, { type }), mimeType: type, durationMs: current.durationMs });
				resolve();
			};
		});
		this.pending.add(done);
		void done.then(() => this.pending.delete(done));
		rec.onerror = () => this.onEnded();
		rec.start();
		this.current = current;
	}

	private endSegment(current: Current | null) {
		if (!current) return;
		current.durationMs = this.elapsedMs - current.startedAt;
		if (current.rec.state !== "inactive") current.rec.stop();
	}
}
