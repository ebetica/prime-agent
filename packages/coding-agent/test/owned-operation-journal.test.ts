import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OwnedOperationJournal } from "../src/core/owned-operation-journal.js";
import { OwnedOperationRegistry } from "../src/core/owned-operation-registry.js";

const dirs: string[] = [];

describe("OwnedOperationJournal", () => {
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("reopens a crash-pending intent and records stopped only after cleanup proof", async () => {
		const dir = mkdtempSync(join(tmpdir(), "owned-operation-journal-"));
		dirs.push(dir);
		const path = join(dir, "stop.json");
		const first = await OwnedOperationJournal.open(path);
		await first.writeStopIntent({
			token: "token-a",
			ownerId: "owner-a",
			operationIds: ["root", "child"],
			kernelRestarted: true,
		});

		const reopened = await OwnedOperationJournal.open(path);
		expect(reopened.pending?.token).toBe("token-a");
		let cleanupFinished = false;
		await reopened.recoverPending(async (record) => {
			expect(record.operationIds).toEqual(["root", "child"]);
			cleanupFinished = true;
		});
		expect(cleanupFinished).toBe(true);
		expect(reopened.pending).toBeUndefined();
		expect(reopened.terminalReceipts).toMatchObject([{ token: "token-a", status: "stopped", kernelRestarted: true }]);

		const final = await OwnedOperationJournal.open(path);
		expect(final.pending).toBeUndefined();
		expect(final.terminalReceipts[0]?.token).toBe("token-a");
		const registry = new OwnedOperationRegistry({ terminalReceipts: final.terminalReceipts });
		expect(await registry.stop("token-a")).toEqual({ status: "already_stopped", kernelRestarted: true });
	});

	it("keeps only a bounded retry window and rejects a mixed pending owner", async () => {
		const dir = mkdtempSync(join(tmpdir(), "owned-operation-journal-"));
		dirs.push(dir);
		const journal = await OwnedOperationJournal.open(join(dir, "stop.json"), { maxTerminalReceipts: 2 });
		for (let index = 0; index < 3; index++) {
			const record = {
				token: `token-${index}`,
				ownerId: `owner-${index}`,
				operationIds: [`operation-${index}`],
				kernelRestarted: false,
			};
			await journal.writeStopIntent(record);
			await journal.writeStopped(record);
		}
		expect(journal.terminalReceipts.map((receipt) => receipt.token)).toEqual(["token-1", "token-2"]);

		await journal.writeStopIntent({
			token: "pending-a",
			ownerId: "owner-a",
			operationIds: ["a"],
			kernelRestarted: false,
		});
		await expect(
			journal.writeStopIntent({
				token: "pending-b",
				ownerId: "owner-b",
				operationIds: ["b"],
				kernelRestarted: false,
			}),
		).rejects.toThrow("pending cleanup");
	});
});
