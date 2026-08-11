import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionActionQueueJournal, sessionActionQueuePath } from "../src/core/session-action-queue-journal.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("SessionActionQueueJournal", () => {
	it("atomically replaces a durable FIFO queue and restores IDs", () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-action-queue-"));
		dirs.push(dir);
		const journal = new SessionActionQueueJournal(dir);
		const queued = { formatVersion: 1 as const, queue: { formatVersion: 1 as const, actions: [{ id: "first" }, { id: "second" }] as never[] }, admittedActionIds: [] };
		journal.write(queued);
		expect(journal.read()).toEqual(queued);
		journal.write({ formatVersion: 1, queue: { formatVersion: 1, actions: [] }, admittedActionIds: ["running"] });
		expect(journal.read()?.admittedActionIds).toEqual(["running"]);
		expect(readFileSync(sessionActionQueuePath(dir), "utf8")).toMatch(/running/);
	});

	it("ignores no queue but rejects a corrupt checkpoint instead of replaying uncertain work", () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-action-queue-"));
		dirs.push(dir);
		const journal = new SessionActionQueueJournal(dir);
		expect(journal.read()).toBeUndefined();
		journal.write({ formatVersion: 1, queue: { formatVersion: 1, actions: [] }, admittedActionIds: [] });
		expect(journal.read()).toBeUndefined();
	});
});
