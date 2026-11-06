import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ScreenWakeLock } from "../src/wakelock";

class FakeSentinel extends EventTarget {
	released = false;
	release() {
		this.released = true;
		this.dispatchEvent(new Event("release"));
		return Promise.resolve();
	}
}

const flush = () => new Promise((r) => setTimeout(r));

let requests: FakeSentinel[];
let refuse: boolean;
let unavailable: number;
let lock: ScreenWakeLock;

const install = () =>
	Object.defineProperty(navigator, "wakeLock", {
		configurable: true,
		value: {
			request: async () => {
				if (refuse) throw new Error("refused");
				const sentinel = new FakeSentinel();
				requests.push(sentinel);
				return sentinel;
			},
		},
	});

beforeEach(() => {
	requests = [];
	refuse = false;
	unavailable = 0;
	lock = new ScreenWakeLock(() => unavailable++);
	install();
	Object.assign(globalThis, { document: { visibilityState: "visible" } });
});

afterEach(() => {
	Reflect.deleteProperty(navigator, "wakeLock");
	Reflect.deleteProperty(globalThis, "document");
});

describe("ScreenWakeLock", () => {
	test("acquires once and releases when no longer wanted", async () => {
		lock.set(true);
		lock.set(true);
		await flush();
		expect(requests.length).toBe(1);
		lock.set(false);
		expect(requests[0]!.released).toBe(true);
	});

	test("releases a lock that resolves after it stopped being wanted", async () => {
		lock.set(true);
		lock.set(false);
		await flush();
		expect(requests[0]!.released).toBe(true);
	});

	test("reacquires after the browser drops the lock", async () => {
		lock.set(true);
		await flush();
		await requests[0]!.release();
		await lock.reacquire();
		expect(requests.length).toBe(2);
		expect(requests[1]!.released).toBe(false);
	});

	test("does not reacquire when not wanted", async () => {
		await lock.reacquire();
		expect(requests.length).toBe(0);
	});

	test("warns once when the request is refused while visible", async () => {
		refuse = true;
		lock.set(true);
		await flush();
		await lock.reacquire();
		expect(unavailable).toBe(1);
	});

	test("stays quiet when refused while hidden, then recovers", async () => {
		refuse = true;
		Object.assign(globalThis, { document: { visibilityState: "hidden" } });
		lock.set(true);
		await flush();
		expect(unavailable).toBe(0);
		refuse = false;
		await lock.reacquire();
		expect(requests.length).toBe(1);
	});

	test("warns when the API does not exist", async () => {
		Reflect.deleteProperty(navigator, "wakeLock");
		lock.set(true);
		await flush();
		expect(unavailable).toBe(1);
	});
});
