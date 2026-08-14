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
	it("publishes an immutable, single-owner operation set and invalidates changed sets", () => {
		const settled = Promise.resolve();
		const registry = new OwnedOperationRegistry();
		const root = registry.admitRoot("agent_run", { interrupt() {}, settled });
		const first = registry.activeSet()!;
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.operations)).toBe(true);
		expect(registry.activeSet()).toBe(first);

		const child = registry.admitChild(root.id, "subprocess", { interrupt() {}, settled });
		const second = registry.activeSet()!;
		expect(second.token).not.toBe(first.token);
		expect(second.operations).toEqual([
			{ id: root.id, kind: "agent_run" },
			{ id: child.id, kind: "subprocess" },
		]);
		expect(() => registry.admitChild("another-owner", "subprocess", { interrupt() {}, settled })).toThrow(
			"admission is closed",
		);
	});

	it("keeps explicit children owned after the root settles and closes late admission", () => {
		const registry = new OwnedOperationRegistry();
		const root = registry.admitRoot("agent_run", { interrupt() {}, settled: Promise.resolve() });
		const child = registry.admitChild(root.id, "kernel_cell", { interrupt() {}, settled: Promise.resolve() });
		registry.complete(root.id);
		expect(registry.activeSet()?.operations).toEqual([{ id: child.id, kind: "kernel_cell" }]);
		expect(() => registry.admitChild(root.id, "subprocess", { interrupt() {}, settled: Promise.resolve() })).toThrow(
			"admission is closed",
		);
		registry.complete(child.id);
		expect(registry.activeSet()).toBeUndefined();
	});

	it("closes admission and returns stopped only after durable intent, settlement, cleanup, and terminal receipt", async () => {
		const task = deferred();
		const cleanup = deferred();
		const order: string[] = [];
		const registry = new OwnedOperationRegistry({
			persistence: {
				async writeStopIntent() {
					order.push("intent");
				},
				async writeStopped() {
					order.push("terminal");
				},
			},
		});
		const root = registry.admitRoot("kernel_cell", {
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
		expect(() => registry.admitChild(root.id, "subprocess", { interrupt() {}, settled: Promise.resolve() })).toThrow(
			"admission is closed",
		);
		expect(order).toEqual(["intent", "interrupt"]);
		task.resolve();
		await Promise.resolve();
		cleanup.resolve();
		expect(await stopping).toEqual({ status: "stopped", kernelRestarted: true });
		expect(order).toEqual(["intent", "interrupt", "settled", "cleanup", "terminal"]);
		expect(await registry.stop(token)).toEqual({ status: "already_stopped", kernelRestarted: true });
		expect(registry.activeSet()).toBeUndefined();
	});

	it("attempts every interrupt and cleanup before fencing a failed stop", async () => {
		const calls: string[] = [];
		const registry = new OwnedOperationRegistry();
		const root = registry.admitRoot("agent_run", {
			interrupt() {
				calls.push("root interrupt");
				throw new Error("root interrupt failed");
			},
			settled: Promise.resolve(),
			cleanup() {
				calls.push("root cleanup");
			},
		});
		registry.admitChild(root.id, "subprocess", {
			interrupt() {
				calls.push("child interrupt");
			},
			settled: Promise.reject(new Error("child settlement failed")),
			cleanup() {
				calls.push("child cleanup");
			},
		});
		const token = registry.activeSet()!.token;
		await expect(registry.stop(token)).rejects.toThrow("did not settle safely");
		expect(calls).toEqual(["root interrupt", "child interrupt", "root cleanup", "child cleanup"]);
		expect(registry.isStopping).toBe(true);
		expect(registry.activeSet()?.token).toBe(token);
	});

	it("never lets a frozen stale token stop a changed or replacement owner", async () => {
		const registry = new OwnedOperationRegistry();
		const root = registry.admitRoot("agent_run", { interrupt() {}, settled: Promise.resolve() });
		const stale = registry.activeSet()!.token;
		registry.admitChild(root.id, "subprocess", { interrupt() {}, settled: Promise.resolve() });
		expect(await registry.stop(stale)).toEqual({ status: "stale" });
		const current = registry.activeSet()!.token;
		expect(await registry.stop(current)).toEqual({ status: "stopped", kernelRestarted: false });

		registry.admitRoot("user_bash", { interrupt() {}, settled: Promise.resolve() });
		expect(await registry.stop(current)).toEqual({ status: "already_stopped", kernelRestarted: false });
		expect(registry.activeSet()?.operations[0]?.kind).toBe("user_bash");
	});
});
