import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withRegistryLease } from "../src/core/rlm-registry-lease.js";

const roots: string[] = [];
function path() {
	const root = mkdtempSync(join(tmpdir(), "registry-lease-"));
	roots.push(root);
	return join(root, "rlm-subagents.jsonl");
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const identity = { machineId: "machine", bootId: "boot", pidNamespace: "pidns" };
describe("RLM registry process lease", () => {
	it("never steals a live holder after the former stale threshold and reports its identity", async () => {
		vi.useFakeTimers();
		const registry = path();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const owner = withRegistryLease(registry, () => held, { identity, processStartId: () => "start", pollMs: 100 });
		await vi.advanceTimersByTimeAsync(1);
		const abort = new AbortController();
		const logs: string[] = [];
		const contender = withRegistryLease(registry, () => undefined, {
			identity,
			processStartId: () => "start",
			pollMs: 100,
			signal: abort.signal,
			onWait: (line) => logs.push(line),
		});
		await vi.advanceTimersByTimeAsync(31_000);
		expect(logs.at(-1)).toContain("holder pid=");
		expect(existsSync(`${registry}.lease`)).toBe(true);
		abort.abort();
		await expect(contender).rejects.toBeDefined();
		expect(readdirSync(join(registry, "..")).filter((name) => name.includes(".candidate."))).toEqual([]);
		release();
		await owner;
		vi.useRealTimers();
	});
	it("serializes contenders without losing either mutation", async () => {
		const registry = path();
		const rows: string[] = [];
		await Promise.all([
			withRegistryLease(registry, async () => {
				rows.push("a");
				await new Promise((r) => setTimeout(r, 20));
			}),
			withRegistryLease(registry, () => {
				rows.push("b");
			}),
		]);
		expect(rows).toEqual(["a", "b"]);
		expect(existsSync(`${registry}.lease`)).toBe(false);
	});
	it("leaves no candidate or claim after release", async () => {
		const registry = path();
		await withRegistryLease(registry, () => undefined);
		expect(readdirSync(join(registry, ".."))).toEqual([]);
	});
});
