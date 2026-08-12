import { describe, expect, it, vi } from "vitest";
import { CoalescedWorkerRefresh } from "../src/modes/daemon/coalesced-worker-refresh.js";
import { createDeferred } from "./suite/scheduling.js";

describe("CoalescedWorkerRefresh", () => {
	it("bounds a refresh storm to one in flight and one newest follow-up", async () => {
		const worker = {};
		const coalescer = new CoalescedWorkerRefresh<object>();
		const gates = [createDeferred<void>(), createDeferred<void>()];
		let active = 0;
		let peak = 0;
		const seen: Array<{ recovery: boolean; revision: number }> = [];
		let revision = 0;
		const refresh = vi.fn(async (recovery: boolean) => {
			active++;
			peak = Math.max(peak, active);
			seen.push({ recovery, revision });
			await gates[seen.length - 1]?.promise;
			active--;
		});

		const first = coalescer.request(worker, false, refresh);
		const storm = Array.from({ length: 500 }, () => {
			revision++;
			return coalescer.request(worker, false, refresh);
		});
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(new Set(storm).size).toBe(1);
		gates[0]!.resolve();
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
		expect(peak).toBe(1);
		gates[1]!.resolve();
		await Promise.all([first, ...storm]);
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(seen).toEqual([
			{ recovery: false, revision: 0 },
			{ recovery: false, revision: 500 },
		]);
	});

	it("keeps workers independent and preserves a pending recovery check", async () => {
		const coalescer = new CoalescedWorkerRefresh<object>();
		const firstWorker = {};
		const secondWorker = {};
		const gate = createDeferred<void>();
		const firstSeen: boolean[] = [];
		const firstRefresh = async (recovery: boolean) => {
			firstSeen.push(recovery);
			if (firstSeen.length === 1) await gate.promise;
		};
		const first = coalescer.request(firstWorker, false, firstRefresh);
		const recovery = coalescer.request(firstWorker, true, firstRefresh);
		const secondRefresh = vi.fn(async () => {});
		await coalescer.request(secondWorker, false, secondRefresh);
		expect(secondRefresh).toHaveBeenCalledOnce();
		gate.resolve();
		await Promise.all([first, recovery]);
		expect(firstSeen).toEqual([false, true]);
	});

	it("rejects only the covered generation and permits a retry", async () => {
		const worker = {};
		const coalescer = new CoalescedWorkerRefresh<object>();
		const refresh = vi.fn().mockRejectedValueOnce(new Error("disconnected")).mockResolvedValue(undefined);
		await expect(coalescer.request(worker, false, refresh)).rejects.toThrow("disconnected");
		await expect(coalescer.request(worker, false, refresh)).resolves.toBeUndefined();
		expect(refresh).toHaveBeenCalledTimes(2);
	});
});
