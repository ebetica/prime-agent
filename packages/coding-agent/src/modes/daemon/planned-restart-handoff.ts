import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getDaemonUpdateRestartManifestPath, getLegacyDaemonUpdateRestartManifestPath } from "../../config.js";
import type {
	DaemonPlannedRestartCompletion,
	DaemonPlannedRestartHandoff,
	DaemonPlannedRestartHandoffState,
	DaemonPlannedRestartLifecycleResult,
} from "./daemon-protocol.js";

const MAX_REQUEST_ID_CHARS = 128;
export const MAX_PLANNED_RESTART_MESSAGE_CHARS = 16_384;
export const MAX_LIVE_PLANNED_RESTART_HANDOFFS = 64;
const MAX_PLANNED_RESTART_RECEIPTS = 256;
const PLANNED_RESTART_RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REGISTERED_HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;
const FAILED_HANDOFF_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

export function isDaemonPlannedRestartCompletion(value: unknown): value is DaemonPlannedRestartCompletion {
	if (!value || typeof value !== "object") return false;
	const completion = value as Partial<DaemonPlannedRestartCompletion>;
	const validIdentity = (identity: unknown): boolean => {
		if (!identity || typeof identity !== "object") return false;
		const candidate = identity as DaemonPlannedRestartCompletion["successor"];
		return (
			Number.isInteger(candidate.pid) &&
			typeof candidate.supervisorGeneration === "string" &&
			typeof candidate.supervisorOwnerToken === "string" &&
			(candidate.processStartId === undefined || typeof candidate.processStartId === "string")
		);
	};
	return (
		typeof completion.requestId === "string" &&
		typeof completion.actionId === "string" &&
		typeof completion.completedAt === "string" &&
		typeof completion.manifestDigest === "string" &&
		validIdentity(completion.predecessor) &&
		validIdentity(completion.successor) &&
		!!completion.counts &&
		Number.isInteger(completion.counts.total) &&
		Number.isInteger(completion.counts.restored) &&
		Number.isInteger(completion.counts.resumed) &&
		Number.isInteger(completion.counts.failed) &&
		Array.isArray(completion.restoredSessions) &&
		completion.restoredSessions.every(
			(session) =>
				typeof session.sourceActiveSessionId === "string" &&
				typeof session.restoredActiveSessionId === "string" &&
				typeof session.sessionId === "string",
		) &&
		Array.isArray(completion.discardedActiveSessionIds) &&
		completion.discardedActiveSessionIds.every((activeSessionId) => typeof activeSessionId === "string") &&
		!!completion.continuation &&
		typeof completion.continuation.sessionId === "string" &&
		typeof completion.continuation.restoredActiveSessionId === "string" &&
		(completion.continuation.admissionStatus === "admitted" ||
			completion.continuation.admissionStatus === "already_admitted") &&
		typeof completion.acknowledgementToken === "string"
	);
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
			handoff.state === "completed" ||
			handoff.state === "failed") &&
		typeof handoff.createdAt === "string" &&
		typeof handoff.updatedAt === "string" &&
		(handoff.error === undefined || typeof handoff.error === "string") &&
		(handoff.completion === undefined || isDaemonPlannedRestartCompletion(handoff.completion)) &&
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

interface PlannedRestartLifecycleReceipt {
	requestId: string;
	status: "acknowledged" | "cancelled";
	updatedAt: string;
	acknowledgementTokenHash?: string;
	ownerHash?: string;
	successor?: {
		supervisorGeneration: string;
		supervisorOwnerTokenHash: string;
		pid: number;
		processStartId?: string;
	};
}

function receiptsDirectory(agentDir: string, socketPath: string): string {
	return join(directory(agentDir, socketPath), "lifecycle-receipts");
}

function receiptPath(agentDir: string, socketPath: string, requestId: string): string {
	return join(receiptsDirectory(agentDir, socketPath), `${createHash("sha256").update(requestId).digest("hex")}.json`);
}

function isLifecycleReceipt(value: unknown): value is PlannedRestartLifecycleReceipt {
	if (!value || typeof value !== "object") return false;
	const receipt = value as PlannedRestartLifecycleReceipt;
	return (
		typeof receipt.requestId === "string" &&
		typeof receipt.updatedAt === "string" &&
		((receipt.status === "acknowledged" &&
			typeof receipt.acknowledgementTokenHash === "string" &&
			!!receipt.successor &&
			typeof receipt.successor.supervisorGeneration === "string" &&
			typeof receipt.successor.supervisorOwnerTokenHash === "string" &&
			Number.isInteger(receipt.successor.pid)) ||
			(receipt.status === "cancelled" && typeof receipt.ownerHash === "string"))
	);
}

function readLifecycleReceipts(agentDir: string, socketPath: string): PlannedRestartLifecycleReceipt[] {
	const root = receiptsDirectory(agentDir, socketPath);
	let entries: string[];
	try {
		entries = readdirSync(root).filter((entry) => entry.endsWith(".json"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return entries.map((entry) => {
		const value = JSON.parse(readFileSync(join(root, entry), "utf8")) as unknown;
		if (!isLifecycleReceipt(value)) throw new Error(`Invalid planned restart lifecycle receipt: ${entry}`);
		return value;
	});
}

function pruneLifecycleReceipts(agentDir: string, socketPath: string, protectedRequestId?: string): void {
	const root = receiptsDirectory(agentDir, socketPath);
	const now = Date.now();
	const receipts = readLifecycleReceipts(agentDir, socketPath).sort((a, b) => {
		if (a.requestId === protectedRequestId) return -1;
		if (b.requestId === protectedRequestId) return 1;
		return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
	});
	let changed = false;
	for (const [index, receipt] of receipts.entries()) {
		if (
			index < MAX_PLANNED_RESTART_RECEIPTS &&
			now - Date.parse(receipt.updatedAt) <= PLANNED_RESTART_RECEIPT_TTL_MS
		) {
			continue;
		}
		rmSync(receiptPath(agentDir, socketPath, receipt.requestId), { force: true });
		changed = true;
	}
	if (changed) fsyncDirectory(root);
}

function lifecycleReceipt(
	agentDir: string,
	socketPath: string,
	requestId: string,
): PlannedRestartLifecycleReceipt | undefined {
	try {
		const value = JSON.parse(readFileSync(receiptPath(agentDir, socketPath, requestId), "utf8")) as unknown;
		if (!isLifecycleReceipt(value) || value.requestId !== requestId) {
			throw new Error(`Invalid planned restart lifecycle receipt for ${requestId}`);
		}
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function recordLifecycleReceipt(agentDir: string, socketPath: string, receipt: PlannedRestartLifecycleReceipt): void {
	const path = receiptPath(agentDir, socketPath, receipt.requestId);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const descriptor = openSync(temporary, "w", 0o600);
	try {
		writeSync(
			descriptor,
			`${JSON.stringify(receipt, null, 2)}
`,
		);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	renameSync(temporary, path);
	fsyncDirectory(dirname(path));
	pruneLifecycleReceipts(agentDir, socketPath, receipt.requestId);
}

function removeHandoff(agentDir: string, socketPath: string, requestId: string): void {
	const path = plannedRestartHandoffPath(agentDir, socketPath, requestId);
	rmSync(path, { force: true });
	const descriptor = openSync(dirname(path), "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function fsyncDirectory(path: string): void {
	const descriptor = openSync(path, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function tokenHash(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function sameToken(token: string, expectedHash: string | undefined): boolean {
	if (!expectedHash) return false;
	const actual = Buffer.from(tokenHash(token), "hex");
	const expected = Buffer.from(expectedHash, "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function reclaimPlannedRestartHandoffs(agentDir: string, socketPath: string, now = Date.now()): void {
	const root = directory(agentDir, socketPath);
	let entries: string[];
	try {
		entries = readdirSync(root).filter((entry) => entry.endsWith(".json") && entry !== "lifecycle-receipts.json");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	let live = 0;
	for (const entry of entries) {
		const path = join(root, entry);
		let handoff: DaemonPlannedRestartHandoff;
		try {
			const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
			if (!isDaemonPlannedRestartHandoff(value)) {
				live++;
				continue;
			}
			handoff = value;
		} catch {
			// Corrupt committed state is in doubt: retain it and count it toward the cap.
			live++;
			continue;
		}
		const age = now - Date.parse(handoff.updatedAt);
		const reclaimable =
			(handoff.state === "registered" && !handoff.claim && age > REGISTERED_HANDOFF_TTL_MS) ||
			(handoff.state === "failed" && !handoff.claim && age > FAILED_HANDOFF_TTL_MS);
		if (reclaimable) {
			removeHandoff(agentDir, socketPath, handoff.requestId);
			continue;
		}
		live++;
	}
	if (live >= MAX_LIVE_PLANNED_RESTART_HANDOFFS) {
		throw new Error(`Too many live planned restart handoffs (${live})`);
	}
	pruneLifecycleReceipts(agentDir, socketPath);
}

export function registerPlannedRestartHandoff(
	agentDir: string,
	socketPath: string,
	input: Omit<DaemonPlannedRestartHandoff, "state" | "createdAt" | "updatedAt">,
): DaemonPlannedRestartHandoff {
	validatePlannedRestartRequest(input.requestId, input.message);
	reclaimPlannedRestartHandoffs(agentDir, socketPath);
	const receipt = lifecycleReceipt(agentDir, socketPath, input.requestId);
	if (receipt) throw new Error(`Planned restart request ${input.requestId} was already ${receipt.status}`);
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
	if (current.state === "completed") return current;
	if (current.state === "delivered" && state !== "completed") return current;
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

export function completePlannedRestartHandoff(
	agentDir: string,
	socketPath: string,
	handoff: DaemonPlannedRestartHandoff,
	completion: Omit<DaemonPlannedRestartCompletion, "acknowledgementToken" | "completedAt">,
): DaemonPlannedRestartHandoff {
	const current = readPlannedRestartHandoff(agentDir, socketPath, handoff.requestId);
	if (!current || current.actionId !== handoff.actionId) {
		throw new Error(`Planned restart marker ${handoff.requestId} is missing or was replaced`);
	}
	if (current.state === "completed" && current.completion) return current;
	if (current.state !== "delivered" || !current.claim) {
		throw new Error(`Planned restart request ${handoff.requestId} has no delivered continuation receipt`);
	}
	if (completion.requestId !== current.requestId || completion.actionId !== current.actionId) {
		throw new Error("Planned restart completion does not match its durable request");
	}
	if (
		completion.predecessor.pid !== current.claim.supervisorPid ||
		completion.predecessor.supervisorGeneration !== current.claim.supervisorGeneration ||
		completion.predecessor.supervisorOwnerToken !== current.claim.supervisorOwnerToken ||
		(current.claim.supervisorProcessStartId !== undefined &&
			completion.predecessor.processStartId !== current.claim.supervisorProcessStartId)
	) {
		throw new Error("Planned restart completion does not match its predecessor claim");
	}
	if (
		completion.successor.supervisorGeneration === current.claim.supervisorGeneration ||
		completion.successor.supervisorOwnerToken === current.claim.supervisorOwnerToken ||
		(completion.successor.pid === current.claim.supervisorPid &&
			current.claim.supervisorProcessStartId !== undefined &&
			completion.successor.processStartId === current.claim.supervisorProcessStartId)
	) {
		throw new Error("Planned restart completion did not come from a replacement successor");
	}
	if (
		completion.counts.total <= 0 ||
		completion.counts.failed !== 0 ||
		completion.counts.restored !== completion.counts.total ||
		completion.restoredSessions.length !== completion.counts.total ||
		completion.continuation.sessionId !== current.target.sessionId ||
		!completion.restoredSessions.some(
			(session) =>
				session.sessionId === completion.continuation.sessionId &&
				session.restoredActiveSessionId === completion.continuation.restoredActiveSessionId,
		)
	) {
		throw new Error("Planned restart completion is not a full successful transaction");
	}
	const completed: DaemonPlannedRestartHandoff = {
		...current,
		state: "completed",
		updatedAt: new Date().toISOString(),
		completion: {
			...completion,
			completedAt: new Date().toISOString(),
			acknowledgementToken: randomBytes(32).toString("base64url"),
		},
	};
	delete completed.error;
	writeHandoff(agentDir, socketPath, completed);
	return completed;
}

export function cancelPlannedRestartHandoff(
	agentDir: string,
	socketPath: string,
	requestId: string,
	expected: { activeSessionId: string; sessionId: string },
): DaemonPlannedRestartLifecycleResult {
	const receipt = lifecycleReceipt(agentDir, socketPath, requestId);
	if (receipt?.status === "cancelled") {
		if (receipt.ownerHash !== tokenHash(`${expected.activeSessionId}\0${expected.sessionId}`)) {
			throw new Error("Planned restart cancellation owner does not match the registered target");
		}
		removeHandoff(agentDir, socketPath, requestId);
		return { status: "already_cancelled" };
	}
	if (receipt) throw new Error(`Planned restart request ${requestId} was already ${receipt.status}`);
	const current = readPlannedRestartHandoff(agentDir, socketPath, requestId);
	if (!current) throw new Error(`Unknown planned restart request: ${requestId}`);
	if (current.target.activeSessionId !== expected.activeSessionId || current.target.sessionId !== expected.sessionId) {
		throw new Error("Planned restart cancellation owner does not match the registered target");
	}
	if ((current.state !== "registered" && current.state !== "failed") || current.claim) {
		throw new Error(`Planned restart request ${requestId} is already ${current.state}`);
	}
	recordLifecycleReceipt(agentDir, socketPath, {
		requestId,
		status: "cancelled",
		updatedAt: new Date().toISOString(),
		ownerHash: tokenHash(`${expected.activeSessionId}\0${expected.sessionId}`),
	});
	removeHandoff(agentDir, socketPath, requestId);
	return { status: "cancelled" };
}

export function acknowledgePlannedRestartHandoff(
	agentDir: string,
	socketPath: string,
	requestId: string,
	acknowledgementToken: string,
	successor: { supervisorGeneration: string; supervisorOwnerToken: string; pid: number; processStartId?: string },
): DaemonPlannedRestartLifecycleResult {
	const receipt = lifecycleReceipt(agentDir, socketPath, requestId);
	if (receipt?.status === "acknowledged") {
		if (!sameToken(acknowledgementToken, receipt.acknowledgementTokenHash)) {
			throw new Error("Planned restart acknowledgement token does not match");
		}
		if (
			receipt.successor?.supervisorGeneration !== successor.supervisorGeneration ||
			receipt.successor.supervisorOwnerTokenHash !== tokenHash(successor.supervisorOwnerToken) ||
			receipt.successor.pid !== successor.pid ||
			(receipt.successor.processStartId !== undefined &&
				receipt.successor.processStartId !== successor.processStartId)
		) {
			throw new Error("Planned restart acknowledgement came from the wrong successor");
		}
		removeHandoff(agentDir, socketPath, requestId);
		return { status: "already_acknowledged" };
	}
	if (receipt) throw new Error(`Planned restart request ${requestId} was already ${receipt.status}`);
	if (
		existsSync(getDaemonUpdateRestartManifestPath(socketPath, agentDir)) ||
		existsSync(getLegacyDaemonUpdateRestartManifestPath(agentDir))
	) {
		throw new Error("Planned restart completion cannot be acknowledged while its manifest is live");
	}
	const current = readPlannedRestartHandoff(agentDir, socketPath, requestId);
	if (!current?.completion || current.state !== "completed") {
		throw new Error(`Planned restart request ${requestId} has no durable completion proof`);
	}
	const expected = current.completion.successor;
	if (
		expected.supervisorGeneration !== successor.supervisorGeneration ||
		expected.supervisorOwnerToken !== successor.supervisorOwnerToken ||
		expected.pid !== successor.pid ||
		(expected.processStartId !== undefined && expected.processStartId !== successor.processStartId)
	) {
		throw new Error("Planned restart acknowledgement came from the wrong successor");
	}
	if (!sameToken(acknowledgementToken, tokenHash(current.completion.acknowledgementToken))) {
		throw new Error("Planned restart acknowledgement token does not match");
	}
	recordLifecycleReceipt(agentDir, socketPath, {
		requestId,
		status: "acknowledged",
		updatedAt: new Date().toISOString(),
		acknowledgementTokenHash: tokenHash(acknowledgementToken),
		successor: {
			supervisorGeneration: successor.supervisorGeneration,
			supervisorOwnerTokenHash: tokenHash(successor.supervisorOwnerToken),
			pid: successor.pid,
			...(successor.processStartId ? { processStartId: successor.processStartId } : {}),
		},
	});
	removeHandoff(agentDir, socketPath, requestId);
	return { status: "acknowledged" };
}
