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
	it("compacts legacy history to one retained latest row and prunes deletion", () => {
		const path = registry();
		writeFileSync(
			path,
			`${[entry("kept", "running"), entry("gone", "running"), entry("kept", "interrupted"), entry("gone", "deleted")]
				.map((value) => JSON.stringify(value))
				.join("\n")}\n`,
		);
		expect(readRlmSubagentRegistry(path)).toEqual([entry("kept", "interrupted")]);
		expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
		mutateRlmSubagentRegistry(path, (latest) => ({
			result: undefined,
			deleteChildId: latest.has("kept") ? "kept" : undefined,
		}));
		expect(readRlmSubagentRegistry(path)).toEqual([]);
		expect(readFileSync(path, "utf8")).toBe("");
	});

	it("migrates 100k historical transitions once, leaving subsequent work O(live)", () => {
		const path = registry();
		const rows: string[] = [];
		for (let i = 0; i < 50_000; i++) {
			rows.push(JSON.stringify(entry(`old-${i % 10}`, "running")));
			rows.push(JSON.stringify(entry(`old-${i % 10}`, "deleted")));
		}
		rows.push(JSON.stringify(entry("live", "running")));
		writeFileSync(path, `${rows.join("\n")}\n`);
		expect(readRlmSubagentRegistry(path).map((value) => value.childId)).toEqual(["live"]);
		const compactBytes = readFileSync(path).byteLength;
		expect(compactBytes).toBeLessThan(1_000);
		mutateRlmSubagentRegistry(path, (latest) => ({
			result: undefined,
			entry: { ...latest.get("live")!, status: "interrupted", updatedAt: "interrupted" },
		}));
		expect(readFileSync(path).byteLength).toBeLessThan(1_000);
		expect(readRlmSubagentRegistry(path)[0]?.status).toBe("interrupted");
	});

	it("fails closed on malformed non-tail rows", () => {
		const path = registry();
		writeFileSync(path, `${JSON.stringify(entry("live", "running"))}\nnot json\n`);
		expect(() => readRlmSubagentRegistry(path)).toThrow("Malformed RLM subagent registry row 2");
	});
});
