/**
 * Holds a screen wake lock while wanted. Browsers drop the lock when the page is hidden,
 * so `reacquire` has to run again once it is visible.
 */
export class ScreenWakeLock {
	private wanted = false;
	private lock: WakeLockSentinel | null = null;
	private requesting = false;
	private warned = false;

	constructor(private readonly onUnavailable: () => void) {}

	set(wanted: boolean) {
		this.wanted = wanted;
		if (wanted) {
			void this.reacquire();
			return;
		}
		void this.lock?.release();
		this.lock = null;
	}

	async reacquire() {
		if (!this.wanted || this.lock || this.requesting) return;
		if (!("wakeLock" in navigator)) return this.warnOnce();
		this.requesting = true;
		try {
			const lock = await navigator.wakeLock.request("screen");
			lock.addEventListener("release", () => {
				if (this.lock === lock) this.lock = null;
			});
			if (this.wanted) this.lock = lock;
			else void lock.release();
		} catch (e) {
			console.warn("[voice-context] wake lock failed", e);
			// A hidden page is always refused; the next `reacquire` covers that case.
			if (document.visibilityState === "visible") this.warnOnce();
		} finally {
			this.requesting = false;
		}
	}

	private warnOnce() {
		if (this.warned) return;
		this.warned = true;
		this.onUnavailable();
	}
}
