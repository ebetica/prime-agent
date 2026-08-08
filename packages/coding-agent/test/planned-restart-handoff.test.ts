import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	plannedRestartHandoffPath,
	readPlannedRestartHandoff,
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

	it("does not expose request ids or payloads in marker paths", () => {
		const { agentDir, socketPath, input } = fixture();
		const path = plannedRestartHandoffPath(agentDir, socketPath, input.requestId);
		expect(basename(path)).not.toContain(input.requestId);
		expect(basename(path)).not.toContain(input.message);
	});
});
