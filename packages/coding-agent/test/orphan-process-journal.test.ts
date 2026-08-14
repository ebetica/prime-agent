import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearOrphanProcessJournal,
	isOrphanProcessIdentityCurrent,
	ORPHAN_PROCESS_JOURNAL_ENV,
	readActiveOrphanProcesses,
	recordOrphanProcessState,
	terminateActiveOrphanProcesses,
} from "../src/core/orphan-process-journal.js";

const tempDirs: string[] = [];
const originalJournalPath = process.env[ORPHAN_PROCESS_JOURNAL_ENV];

afterEach(() => {
	if (originalJournalPath === undefined) {
		delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	} else {
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = originalJournalPath;
	}
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("orphan process journal", () => {
	it("retains only detached processes still active for the crashed owner", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;

		recordOrphanProcessState(process.pid, true);

		const active = readActiveOrphanProcesses(path, process.pid);
		expect(active).toHaveLength(1);
		expect(active[0]?.pid).toBe(process.pid);
		expect(active[0] && isOrphanProcessIdentityCurrent(active[0])).toBe(true);
		expect(readActiveOrphanProcesses(path, process.pid + 1)).toEqual([]);

		recordOrphanProcessState(process.pid, false);
		expect(readActiveOrphanProcesses(path, process.pid)).toEqual([]);
		clearOrphanProcessJournal(path);
		expect(existsSync(path)).toBe(false);
	});

	it("retains the cleanup receipt after the exact tracked identity is confirmed gone", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-cleanup-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
		recordOrphanProcessState(process.pid, true);
		let current = true;
		const signaled: number[] = [];
		await expect(
			terminateActiveOrphanProcesses(path, process.pid, {
				identityStatus: () => (current ? "current" : "gone"),
				signal: (pid) => {
					signaled.push(pid);
					current = false;
				},
			}),
		).resolves.toBe(1);
		expect(signaled).toEqual([process.pid]);
		expect(existsSync(path)).toBe(true);
	});

	it("keeps the confirmed-gone count stable across a recovery retry", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-cleanup-retry-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
		recordOrphanProcessState(process.pid, true);
		await expect(
			terminateActiveOrphanProcesses(path, process.pid, {
				identityStatus: () => "gone",
				signal: () => {
					throw new Error("must not signal an identity already confirmed gone");
				},
			}),
		).resolves.toBe(1);
		expect(existsSync(path)).toBe(true);
	});

	it("retains cleanup facts when a tracked identity remains alive", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-cleanup-blocked-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
		recordOrphanProcessState(process.pid, true);
		await expect(
			terminateActiveOrphanProcesses(path, process.pid, {
				identityStatus: () => "current",
				signal: () => {},
				timeoutMs: 0,
			}),
		).rejects.toThrow("did not terminate");
		expect(existsSync(path)).toBe(true);
	});

	it("retains cleanup facts when process identity is temporarily unobservable", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-cleanup-unknown-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
		recordOrphanProcessState(process.pid, true);
		await expect(
			terminateActiveOrphanProcesses(path, process.pid, {
				identityStatus: () => "unknown",
				signal: () => {
					throw new Error("must not signal an unverified identity");
				},
			}),
		).rejects.toThrow("could not be verified");
		expect(existsSync(path)).toBe(true);
	});
});
