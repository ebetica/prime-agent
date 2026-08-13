import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDaemonUpdateRestartManifestPath } from "../src/config.js";
import {
	acknowledgePlannedRestartHandoff,
	cancelPlannedRestartHandoff,
	completePlannedRestartHandoff,
	plannedRestartHandoffPath,
	readPlannedRestartHandoff,
	reclaimPlannedRestartHandoffs,
	registerPlannedRestartHandoff,
	updatePlannedRestartHandoff,
} from "../src/modes/daemon/planned-restart-handoff.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const agentDir = mkdtempSync(join(tmpdir(), "prime-planned-restart-"));
	roots.push(agentDir);
	const socketPath = join(agentDir, "daemon.sock");
	const input = {
		requestId: "restart-1",
		target: {
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: join(agentDir, "session.jsonl"),
		},
		message: "Restart complete; continue the saved handoff.",
		actionId: "planned-restart:action-1",
	};
	return { agentDir, socketPath, input };
}

describe("planned restart handoff store", () => {
	it("deduplicates an identical registration and rejects conflicting reuse", () => {
		const { agentDir, socketPath, input } = fixture();
		const first = registerPlannedRestartHandoff(agentDir, socketPath, input);
		const duplicate = registerPlannedRestartHandoff(agentDir, socketPath, input);
		expect(duplicate).toEqual(first);
		expect(() => registerPlannedRestartHandoff(agentDir, socketPath, { ...input, message: "different" })).toThrow(
			/conflicts with its durable marker/,
		);
	});

	it("keeps failed markers actionable and persists delivery acknowledgement", () => {
		const { agentDir, socketPath, input } = fixture();
		const registered = registerPlannedRestartHandoff(agentDir, socketPath, input);
		const failed = updatePlannedRestartHandoff(agentDir, socketPath, registered, "failed", "child (a1): turn");
		expect(readPlannedRestartHandoff(agentDir, socketPath, input.requestId)).toEqual(failed);
		expect(failed.error).toContain("child");

		const claim = {
			claimedAt: new Date().toISOString(),
			supervisorGeneration: "predecessor-generation",
			supervisorOwnerToken: "predecessor-owner",
			supervisorPid: 123,
			supervisorSocketPath: socketPath,
		};
		const prepared = updatePlannedRestartHandoff(agentDir, socketPath, failed, "prepared", undefined, claim);
		const afterCommitFailure = updatePlannedRestartHandoff(
			agentDir,
			socketPath,
			prepared,
			"failed",
			"worker stop reply was lost",
		);
		expect(afterCommitFailure).toMatchObject({ state: "prepared", claim, error: "worker stop reply was lost" });
		const delivered = updatePlannedRestartHandoff(agentDir, socketPath, afterCommitFailure, "delivered");
		expect(delivered.claim).toEqual(claim);
		expect(delivered.error).toBeUndefined();
		expect(updatePlannedRestartHandoff(agentDir, socketPath, prepared, "failed", "lost reply")).toEqual(delivered);
		const mode = readFileSync(plannedRestartHandoffPath(agentDir, socketPath, input.requestId));
		expect(mode.length).toBeGreaterThan(0);
	});

	it("persists a full completion proof before authenticated acknowledgement prunes payload", () => {
		const { agentDir, socketPath, input } = fixture();
		const registered = registerPlannedRestartHandoff(agentDir, socketPath, input);
		const claim = {
			claimedAt: new Date().toISOString(),
			supervisorGeneration: "predecessor-generation",
			supervisorOwnerToken: "predecessor-owner",
			supervisorPid: 123,
			supervisorProcessStartId: "predecessor-start",
			supervisorSocketPath: socketPath,
		};
		const prepared = updatePlannedRestartHandoff(agentDir, socketPath, registered, "prepared", undefined, claim);
		const delivered = updatePlannedRestartHandoff(agentDir, socketPath, prepared, "delivered");
		const completed = completePlannedRestartHandoff(agentDir, socketPath, delivered, {
			requestId: input.requestId,
			actionId: input.actionId,
			manifestDigest: "manifest-digest",
			predecessor: {
				pid: 123,
				processStartId: "predecessor-start",
				supervisorGeneration: "predecessor-generation",
				supervisorOwnerToken: "predecessor-owner",
			},
			successor: {
				pid: 456,
				processStartId: "successor-start",
				supervisorGeneration: "successor-generation",
				supervisorOwnerToken: "successor-owner",
			},
			counts: { total: 1, restored: 1, resumed: 1, failed: 0 },
			restoredSessions: [
				{ sourceActiveSessionId: "active-1", restoredActiveSessionId: "active-2", sessionId: "session-1" },
			],
			discardedActiveSessionIds: [],
			continuation: {
				sessionId: "session-1",
				restoredActiveSessionId: "active-2",
				admissionStatus: "admitted",
			},
		});
		expect(completed).toMatchObject({ state: "completed", completion: { manifestDigest: "manifest-digest" } });
		const token = completed.completion?.acknowledgementToken;
		expect(token).toBeTruthy();
		const manifestPath = getDaemonUpdateRestartManifestPath(socketPath, agentDir);
		mkdirSync(dirname(manifestPath), { recursive: true });
		writeFileSync(manifestPath, "live");
		expect(() =>
			acknowledgePlannedRestartHandoff(agentDir, socketPath, input.requestId, token!, {
				supervisorGeneration: "successor-generation",
				supervisorOwnerToken: "successor-owner",
				pid: 456,
				processStartId: "successor-start",
			}),
		).toThrow(/manifest is live/);
		rmSync(manifestPath);
		expect(() =>
			acknowledgePlannedRestartHandoff(agentDir, socketPath, input.requestId, token!, {
				supervisorGeneration: "other",
				supervisorOwnerToken: "successor-owner",
				pid: 456,
				processStartId: "successor-start",
			}),
		).toThrow(/wrong successor/);
		const successor = {
			supervisorGeneration: "successor-generation",
			supervisorOwnerToken: "successor-owner",
			pid: 456,
			processStartId: "successor-start",
		};
		expect(acknowledgePlannedRestartHandoff(agentDir, socketPath, input.requestId, token!, successor)).toEqual({
			status: "acknowledged",
		});
		expect(readPlannedRestartHandoff(agentDir, socketPath, input.requestId)).toBeUndefined();
		const receiptDirectory = join(
			dirname(plannedRestartHandoffPath(agentDir, socketPath, input.requestId)),
			"lifecycle-receipts",
		);
		const receiptText = readFileSync(join(receiptDirectory, readdirSync(receiptDirectory)[0]!), "utf8");
		for (const sensitive of [input.message, input.target.sessionFile, "session-1", "successor-owner", token!]) {
			expect(receiptText).not.toContain(sensitive);
		}
		expect(() =>
			acknowledgePlannedRestartHandoff(agentDir, socketPath, input.requestId, token!, {
				...successor,
				supervisorGeneration: "later-generation",
			}),
		).toThrow(/wrong successor/);
		expect(acknowledgePlannedRestartHandoff(agentDir, socketPath, input.requestId, token!, successor)).toEqual({
			status: "already_acknowledged",
		});
		expect(() => registerPlannedRestartHandoff(agentDir, socketPath, input)).toThrow(/already acknowledged/);
	});

	it("cancels only the unclaimed request owner and reclaims only stale unclaimed state", () => {
		const first = fixture();
		registerPlannedRestartHandoff(first.agentDir, first.socketPath, first.input);
		expect(() =>
			cancelPlannedRestartHandoff(first.agentDir, first.socketPath, first.input.requestId, {
				activeSessionId: "other",
				sessionId: "session-1",
			}),
		).toThrow(/owner/);
		expect(
			cancelPlannedRestartHandoff(first.agentDir, first.socketPath, first.input.requestId, {
				activeSessionId: "active-1",
				sessionId: "session-1",
			}),
		).toEqual({ status: "cancelled" });
		expect(() =>
			cancelPlannedRestartHandoff(first.agentDir, first.socketPath, first.input.requestId, {
				activeSessionId: "active-other",
				sessionId: "session-other",
			}),
		).toThrow(/owner does not match/);
		expect(
			cancelPlannedRestartHandoff(first.agentDir, first.socketPath, first.input.requestId, {
				activeSessionId: "active-1",
				sessionId: "session-1",
			}),
		).toEqual({ status: "already_cancelled" });

		const second = fixture();
		const registered = registerPlannedRestartHandoff(second.agentDir, second.socketPath, second.input);
		const claim = {
			claimedAt: new Date().toISOString(),
			supervisorGeneration: "predecessor-generation",
			supervisorOwnerToken: "predecessor-owner",
			supervisorPid: 123,
			supervisorSocketPath: second.socketPath,
		};
		updatePlannedRestartHandoff(second.agentDir, second.socketPath, registered, "prepared", undefined, claim);
		expect(() =>
			cancelPlannedRestartHandoff(second.agentDir, second.socketPath, second.input.requestId, {
				activeSessionId: "active-1",
				sessionId: "session-1",
			}),
		).toThrow(/already prepared/);

		const third = fixture();
		const stale = registerPlannedRestartHandoff(third.agentDir, third.socketPath, third.input);
		reclaimPlannedRestartHandoffs(
			third.agentDir,
			third.socketPath,
			Date.parse(stale.updatedAt) + 25 * 60 * 60 * 1000,
		);
		expect(readPlannedRestartHandoff(third.agentDir, third.socketPath, third.input.requestId)).toBeUndefined();
	});

	it("does not expose request ids or payloads in marker paths", () => {
		const { agentDir, socketPath, input } = fixture();
		const path = plannedRestartHandoffPath(agentDir, socketPath, input.requestId);
		expect(basename(path)).not.toContain(input.requestId);
		expect(basename(path)).not.toContain(input.message);
	});
});
