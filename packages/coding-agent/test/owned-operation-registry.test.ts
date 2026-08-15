import { describe, expect, it } from "vitest";
import { OwnedOperationRegistry } from "../src/core/owned-operation-registry.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("OwnedOperationRegistry", () => {
	it("publishes one immutable root set with a stable token", () => {
		const registry = new OwnedOperationRegistry();
		const root = registry.admitRoot("agent_run", { interrupt() {}, settled: Promise.resolve() });
		const first = registry.activeSet()!;
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.operations)).toBe(true);
		expect(first.operations).toEqual([{ id: root.id, kind: "agent_run" }]);
		expect(registry.activeSet()).toBe(first);
	});

	it("returns stopped only after interrupt, settlement, and broad cleanup", async () => {
		const task = deferred();
		const cleanup = deferred();
		const order: string[] = [];
		const registry = new OwnedOperationRegistry();
		registry.admitRoot("agent_run", {
			interrupt() {
				order.push("interrupt");
			},
			settled: task.promise.then(() => {
				order.push("settled");
			}),
			cleanup: () =>
				cleanup.promise.then(() => {
					order.push("cleanup");
				}),
		});
		const token = registry.activeSet()!.token;
		const stopping = registry.stop(token);
		await Promise.resolve();
		expect(registry.isStopping).toBe(true);
		expect(order).toEqual(["interrupt"]);
		task.resolve();
		await Promise.resolve();
		cleanup.resolve();
		expect(await stopping).toEqual({ status: "stopped" });
		expect(order).toEqual(["interrupt", "settled", "cleanup"]);
		expect(await registry.stop(token)).toEqual({ status: "already_stopped" });
		expect(registry.activeSet()).toBeUndefined();
	});

	it("retains the exact owner fence when cleanup cannot be verified", async () => {
		const registry = new OwnedOperationRegistry();
		registry.admitRoot("agent_run", {
			interrupt() {
				throw new Error("interrupt failed");
			},
			settled: Promise.resolve(),
			cleanup() {},
		});
		const token = registry.activeSet()!.token;
		await expect(registry.stop(token)).rejects.toThrow("did not settle safely");
		expect(registry.isStopping).toBe(true);
		expect(registry.activeSet()?.token).toBe(token);
		expect(() => registry.admitRoot("user_bash", { interrupt() {}, settled: Promise.resolve() })).toThrow(
			"already admitted",
		);
	});

	it("never lets a predecessor token affect its replacement owner", async () => {
		const registry = new OwnedOperationRegistry();
		const first = registry.admitRoot("agent_run", { interrupt() {}, settled: Promise.resolve() });
		const predecessor = registry.activeSet()!.token;
		registry.complete(first.id);
		registry.admitRoot("user_bash", { interrupt() {}, settled: Promise.resolve() });
		expect(await registry.stop(predecessor)).toEqual({ status: "stale" });
		expect(registry.activeSet()?.operations[0]?.kind).toBe("user_bash");
	});
});
