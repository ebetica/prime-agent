import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	mutateRlmSubagentRegistry,
	type PersistedRlmSubagentRegistryEntry,
	readRlmSubagentRegistry,
} from "../src/core/rlm-subagent-registry.js";

const roots: string[] = [];
function entry(
	childId: string,
	status: PersistedRlmSubagentRegistryEntry["status"],
): PersistedRlmSubagentRegistryEntry {
	return {
		type: "rlm_subagent",
		childId,
		sessionName: childId,
		sessionDir: `/tmp/${childId}`,
		sessionFile: `/tmp/${childId}.jsonl`,
		parentSessionId: "parent",
		status,
		createdAt: 1,
		updatedAt: status,
	};
}
function registry(): string {
	const root = mkdtempSync(join(tmpdir(), "rlm-registry-"));
	roots.push(root);
	return join(root, "rlm-subagents.jsonl");
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("RLM subagent registry", () => {
	it("compacts legacy history to one retained latest row and prunes deletion", async () => {
		const path = registry();
		writeFileSync(
			path,
			`${[entry("kept", "running"), entry("gone", "running"), entry("kept", "interrupted"), entry("gone", "deleted")]
				.map((value) => JSON.stringify(value))
				.join("\n")}\n`,
		);
		expect(await readRlmSubagentRegistry(path)).toEqual([entry("kept", "interrupted")]);
		expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
		await mutateRlmSubagentRegistry(path, (latest) => ({
			result: undefined,
			deleteChildId: latest.has("kept") ? "kept" : undefined,
		}));
		expect(await readRlmSubagentRegistry(path)).toEqual([]);
		expect(readFileSync(path, "utf8")).toBe("");
	});

	it("migrates 100k historical transitions once, leaving subsequent work O(live)", async () => {
		const path = registry();
		const rows: string[] = [];
		for (let i = 0; i < 50_000; i++) {
			rows.push(JSON.stringify(entry(`old-${i % 10}`, "running")));
			rows.push(JSON.stringify(entry(`old-${i % 10}`, "deleted")));
		}
		rows.push(JSON.stringify(entry("live", "running")));
		writeFileSync(path, `${rows.join("\n")}\n`);
		expect((await readRlmSubagentRegistry(path)).map((value) => value.childId)).toEqual(["live"]);
		const compactBytes = readFileSync(path).byteLength;
		expect(compactBytes).toBeLessThan(1_000);
		await mutateRlmSubagentRegistry(path, (latest) => ({
			result: undefined,
			entry: { ...latest.get("live")!, status: "interrupted", updatedAt: "interrupted" },
		}));
		expect(readFileSync(path).byteLength).toBeLessThan(1_000);
		expect((await readRlmSubagentRegistry(path))[0]?.status).toBe("interrupted");
	});

	it("keeps non-owner reads non-mutating during legacy compaction", async () => {
		const path = registry();
		const first = entry("child-1", "running");
		const completed = { ...first, status: "completed" as const, updatedAt: "completed" };
		const legacy = `${JSON.stringify(first)}\n${JSON.stringify(completed)}\n`;
		writeFileSync(path, legacy);
		expect(await readRlmSubagentRegistry(path, { compact: false })).toEqual([completed]);
		expect(readFileSync(path, "utf8")).toBe(legacy);
	});

	it("fails closed on malformed non-tail rows", async () => {
		const path = registry();
		writeFileSync(path, `${JSON.stringify(entry("live", "running"))}\nnot json\n`);
		await expect(readRlmSubagentRegistry(path)).rejects.toThrow("Malformed RLM subagent registry row 2");
	});
});
