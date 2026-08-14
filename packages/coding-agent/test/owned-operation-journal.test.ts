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
		let releaseCleanup!: () => void;
		const cleanupGate = new Promise<void>((resolve) => {
			releaseCleanup = resolve;
		});
		let cleanupRuns = 0;
		const cleanup = async (record: { operationIds: readonly string[] }) => {
			cleanupRuns++;
			expect(record.operationIds).toEqual(["root", "child"]);
			await cleanupGate;
		};
		const recovery = reopened.recoverPending(cleanup);
		const concurrentRecovery = reopened.recoverPending(cleanup);
		expect(concurrentRecovery).toBe(recovery);
		releaseCleanup();
		expect(await recovery).toBe(true);
		expect(await concurrentRecovery).toBe(true);
		expect(cleanupRuns).toBe(1);
		expect(reopened.pending).toBeUndefined();
		expect(reopened.terminalReceipts).toMatchObject([{ token: "token-a", status: "stopped", kernelRestarted: true }]);

		const final = await OwnedOperationJournal.open(path);
		expect(final.pending).toBeUndefined();
		expect(final.terminalReceipts[0]?.token).toBe("token-a");
		const registry = new OwnedOperationRegistry({ terminalReceipts: final.terminalReceipts });
		expect(await registry.stop("token-a")).toEqual({ status: "already_stopped", kernelRestarted: true });
	});

	it("does not publish an optimistic intent before the durable writer succeeds", async () => {
		const dir = mkdtempSync(join(tmpdir(), "owned-operation-journal-"));
		dirs.push(dir);
		let writerReached!: () => void;
		const reached = new Promise<void>((resolve) => {
			writerReached = resolve;
		});
		let releaseWriter!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseWriter = resolve;
		});
		const journal = await OwnedOperationJournal.open(join(dir, "stop.json"), {
			durableWriter: async () => {
				writerReached();
				await gate;
				throw new Error("pre-rename write failed");
			},
		});
		const writing = journal.writeStopIntent({
			token: "not-durable-yet",
			ownerId: "owner",
			operationIds: ["operation"],
			kernelRestarted: false,
		});
		await reached;
		expect(journal.pending).toBeUndefined();
		expect(await journal.recoverPending(async () => {})).toBe(false);
		releaseWriter();
		await expect(writing).rejects.toThrow("pre-rename write failed");
		expect(journal.pending).toBeUndefined();
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
				token: "pending-a",
				ownerId: "different-owner",
				operationIds: ["a"],
				kernelRestarted: false,
			}),
		).rejects.toThrow("immutable durable stop intent");
		await expect(
			journal.writeStopped({
				token: "pending-a",
				ownerId: "different-owner",
				operationIds: ["a"],
				kernelRestarted: false,
			}),
		).rejects.toThrow("immutable durable intent");
		expect(journal.pending?.ownerId).toBe("owner-a");
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
