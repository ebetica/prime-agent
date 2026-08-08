import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DaemonPlannedRestartHandoff, DaemonPlannedRestartHandoffState } from "./daemon-protocol.js";

const MAX_REQUEST_ID_CHARS = 128;
export const MAX_PLANNED_RESTART_MESSAGE_CHARS = 16_384;

function key(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function directory(agentDir: string, socketPath: string): string {
	return join(resolve(agentDir), "planned-restart-handoffs", key(resolve(socketPath)).slice(0, 24));
}

export function plannedRestartHandoffPath(agentDir: string, socketPath: string, requestId: string): string {
	return join(directory(agentDir, socketPath), `${key(requestId)}.json`);
}

export function validatePlannedRestartRequest(requestId: string, message: string): void {
	if (!requestId || requestId.length > MAX_REQUEST_ID_CHARS || /[\u0000-\u001f\u007f]/u.test(requestId)) {
		throw new Error("Planned restart requestId must be 1-128 printable characters");
	}
	if (!message || message.length > MAX_PLANNED_RESTART_MESSAGE_CHARS) {
		throw new Error(`Planned restart message must be 1-${MAX_PLANNED_RESTART_MESSAGE_CHARS} characters`);
	}
}

export function isDaemonPlannedRestartHandoff(value: unknown): value is DaemonPlannedRestartHandoff {
	if (!value || typeof value !== "object") return false;
	const handoff = value as Partial<DaemonPlannedRestartHandoff>;
	const target = handoff.target;
	return (
		typeof handoff.requestId === "string" &&
		typeof handoff.message === "string" &&
		typeof handoff.actionId === "string" &&
		(handoff.state === "registered" ||
			handoff.state === "prepared" ||
			handoff.state === "delivered" ||
			handoff.state === "failed") &&
		typeof handoff.createdAt === "string" &&
		typeof handoff.updatedAt === "string" &&
		(handoff.error === undefined || typeof handoff.error === "string") &&
		(handoff.claim === undefined ||
			(typeof handoff.claim.claimedAt === "string" &&
				typeof handoff.claim.supervisorGeneration === "string" &&
				typeof handoff.claim.supervisorOwnerToken === "string" &&
				Number.isInteger(handoff.claim.supervisorPid) &&
				typeof handoff.claim.supervisorSocketPath === "string")) &&
		!!target &&
		typeof target.activeSessionId === "string" &&
		typeof target.sessionId === "string" &&
		typeof target.sessionFile === "string"
	);
}

export function readPlannedRestartHandoff(
	agentDir: string,
	socketPath: string,
	requestId: string,
): DaemonPlannedRestartHandoff | undefined {
	try {
		const parsed = JSON.parse(
			readFileSync(plannedRestartHandoffPath(agentDir, socketPath, requestId), "utf8"),
		) as unknown;
		if (!isDaemonPlannedRestartHandoff(parsed) || parsed.requestId !== requestId) {
			throw new Error(`Invalid planned restart marker for ${requestId}`);
		}
		return parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function writeHandoff(agentDir: string, socketPath: string, handoff: DaemonPlannedRestartHandoff): void {
	const path = plannedRestartHandoffPath(agentDir, socketPath, handoff.requestId);
	mkdirSync(directory(agentDir, socketPath), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const descriptor = openSync(temporary, "w", 0o600);
		try {
			writeSync(descriptor, `${JSON.stringify(handoff, null, 2)}\n`);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		renameSync(temporary, path);
		const directoryDescriptor = openSync(dirname(path), "r");
		try {
			fsyncSync(directoryDescriptor);
		} finally {
			closeSync(directoryDescriptor);
		}
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

export function registerPlannedRestartHandoff(
	agentDir: string,
	socketPath: string,
	input: Omit<DaemonPlannedRestartHandoff, "state" | "createdAt" | "updatedAt">,
): DaemonPlannedRestartHandoff {
	validatePlannedRestartRequest(input.requestId, input.message);
	const existing = readPlannedRestartHandoff(agentDir, socketPath, input.requestId);
	if (existing) {
		if (
			existing.message !== input.message ||
			existing.actionId !== input.actionId ||
			existing.target.activeSessionId !== input.target.activeSessionId ||
			existing.target.sessionId !== input.target.sessionId ||
			resolve(existing.target.sessionFile) !== resolve(input.target.sessionFile)
		) {
			throw new Error(`Planned restart request ${input.requestId} conflicts with its durable marker`);
		}
		return existing;
	}
	const now = new Date().toISOString();
	const handoff: DaemonPlannedRestartHandoff = { ...input, state: "registered", createdAt: now, updatedAt: now };
	writeHandoff(agentDir, socketPath, handoff);
	return handoff;
}

export function updatePlannedRestartHandoff(
	agentDir: string,
	socketPath: string,
	handoff: DaemonPlannedRestartHandoff,
	state: DaemonPlannedRestartHandoffState,
	error?: string,
	claim?: DaemonPlannedRestartHandoff["claim"],
): DaemonPlannedRestartHandoff {
	const current = readPlannedRestartHandoff(agentDir, socketPath, handoff.requestId);
	if (!current || current.actionId !== handoff.actionId) {
		throw new Error(`Planned restart marker ${handoff.requestId} is missing or was replaced`);
	}
	if (current.state === "delivered") return current;
	const nextState = current.state === "prepared" && state === "failed" ? "prepared" : state;
	const updated: DaemonPlannedRestartHandoff = {
		...current,
		state: nextState,
		updatedAt: new Date().toISOString(),
		...(claim ? { claim } : {}),
	};
	if (error) updated.error = error;
	else delete updated.error;
	writeHandoff(agentDir, socketPath, updated);
	return updated;
}
