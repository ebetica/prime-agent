import {
	closeSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { getProcessStartId } from "./session-lease.js";

export const ORPHAN_PROCESS_JOURNAL_ENV = "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL";

interface OrphanProcessRecord {
	version: 1;
	pid: number;
	ownerPid: number;
	processStartId?: string;
	active: boolean;
	legacy?: boolean;
	recordedAt: string;
}

export interface ActiveOrphanProcess {
	pid: number;
	processStartId: string;
}

const COMPACT_BYTES = 64 * 1024;

/** Synchronous APIs serialize appends/compaction within one worker event loop. */
function compactOrphanJournal(path: string): void {
	const latest = new Map<string, OrphanProcessRecord>();
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line) continue;
		try {
			const record = JSON.parse(line) as OrphanProcessRecord;
			if (record.version !== 1 || !Number.isInteger(record.pid) || !Number.isInteger(record.ownerPid)) continue;
			const key = record.legacy
				? `${record.ownerPid}:${record.pid}:legacy`
				: `${record.ownerPid}:${record.pid}:${record.processStartId ?? "invalid"}`;
			latest.set(key, record);
		} catch {
			// A crash may truncate only the final append.
		}
	}
	const active = [...latest.values()].filter((record) => record.active && (record.legacy || record.processStartId));
	const temp = `${path}.compact.tmp`;
	try {
		unlinkSync(temp);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	let renamed = false;
	try {
		const descriptor = openSync(temp, "wx", 0o600);
		try {
			const contents = active.map((record) => JSON.stringify(record)).join("\n") + (active.length ? "\n" : "");
			const written = writeSync(descriptor, contents);
			if (written !== Buffer.byteLength(contents)) throw new Error("Short write compacting orphan process journal");
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		renameSync(temp, path);
		renamed = true;
		const parent = openSync(dirname(path), "r");
		try {
			fsyncSync(parent);
		} finally {
			closeSync(parent);
		}
	} finally {
		if (!renamed) {
			try {
				unlinkSync(temp);
			} catch {
				/* no residue */
			}
		}
	}
}

function appendOrphanRecord(record: OrphanProcessRecord): void {
	const path = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	if (!path) throw new Error(`${ORPHAN_PROCESS_JOURNAL_ENV} is not configured`);
	const descriptor = openSync(path, "a", 0o600);
	try {
		const line = `${JSON.stringify(record)}\n`;
		const written = writeSync(descriptor, line);
		if (written !== Buffer.byteLength(line)) throw new Error("Short write to orphan process journal");
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	if (!record.active || statSync(path).size > COMPACT_BYTES) compactOrphanJournal(path);
}

/** Durably register before admitting contained work; failure is fatal. */
export function registerOrphanProcessDurably(pid: number): ActiveOrphanProcess {
	if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid orphan process pid: ${pid}`);
	const processStartId = getProcessStartId(pid);
	if (!processStartId) throw new Error(`Could not establish start identity for orphan process ${pid}`);
	const identity = { pid, processStartId };
	appendOrphanRecord({
		version: 1,
		pid,
		ownerPid: process.pid,
		processStartId,
		active: true,
		recordedAt: new Date().toISOString(),
	});
	return identity;
}

export function unregisterOrphanProcessDurably(identity: ActiveOrphanProcess): void {
	appendOrphanRecord({
		version: 1,
		pid: identity.pid,
		ownerPid: process.pid,
		processStartId: identity.processStartId,
		active: false,
		recordedAt: new Date().toISOString(),
	});
}

export function recordOrphanProcessState(pid: number, active: boolean): void {
	const path = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	if (!path || !Number.isInteger(pid) || pid <= 0) return;
	try {
		const processStartId = active ? getProcessStartId(pid) : undefined;
		appendOrphanRecord({
			version: 1,
			pid,
			ownerPid: process.pid,
			...(processStartId ? { processStartId } : {}),
			active,
			legacy: true,
			recordedAt: new Date().toISOString(),
		});
	} catch {
		// Legacy tracking must not make a successfully spawned command fail.
	}
}

export function readActiveOrphanProcesses(path: string, ownerPid: number): ActiveOrphanProcess[] {
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
	const latest = new Map<string, OrphanProcessRecord>();
	for (const line of contents.split("\n")) {
		if (!line) {
			continue;
		}
		try {
			const record = JSON.parse(line) as Partial<OrphanProcessRecord>;
			if (
				record.version === 1 &&
				Number.isInteger(record.pid) &&
				(record.pid ?? 0) > 0 &&
				record.ownerPid === ownerPid &&
				typeof record.active === "boolean" &&
				typeof record.recordedAt === "string"
			) {
				const parsed = record as OrphanProcessRecord;
				const key = parsed.legacy ? `${parsed.pid}:legacy` : `${parsed.pid}:${parsed.processStartId ?? "legacy"}`;
				latest.set(key, parsed);
			}
		} catch {
			// A crash can truncate only the final append.
		}
	}
	return [...latest.values()]
		.filter(
			(record): record is OrphanProcessRecord & { processStartId: string } =>
				record.active && typeof record.processStartId === "string",
		)
		.map((record) => ({ pid: record.pid, processStartId: record.processStartId }));
}

export type OrphanProcessIdentityStatus = "current" | "gone" | "unknown";

export function orphanProcessIdentityStatus(orphan: ActiveOrphanProcess): OrphanProcessIdentityStatus {
	const observedStartId = getProcessStartId(orphan.pid);
	if (observedStartId === orphan.processStartId) return "current";
	if (observedStartId !== undefined) return "gone";
	try {
		process.kill(orphan.pid, 0);
		return "unknown";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown";
	}
}

export function isOrphanProcessIdentityCurrent(orphan: ActiveOrphanProcess): boolean {
	return orphanProcessIdentityStatus(orphan) === "current";
}

export function clearOrphanProcessJournal(path: string): void {
	rmSync(path, { force: true });
}

export interface TerminateActiveOrphanProcessOptions {
	timeoutMs?: number;
	pollMs?: number;
	identityStatus?: (orphan: ActiveOrphanProcess) => OrphanProcessIdentityStatus;
	signal?: (pid: number) => void;
	delay?: (milliseconds: number) => Promise<void>;
}

/** Kill only journaled PID/start-id identities and clear the journal only after
 * every identity is authoritatively gone. The returned count contains no
 * process metadata and is safe to include in a recovery notice. */
export async function terminateActiveOrphanProcesses(
	path: string,
	ownerPid: number,
	options: TerminateActiveOrphanProcessOptions = {},
): Promise<number> {
	const identityStatus = options.identityStatus ?? orphanProcessIdentityStatus;
	const journaled = readActiveOrphanProcesses(path, ownerPid);
	if (journaled.length > 256) {
		throw new Error("Tracked worker background process count exceeds the bounded recovery payload");
	}
	const active: ActiveOrphanProcess[] = [];
	for (const orphan of journaled) {
		const status = identityStatus(orphan);
		if (status === "unknown") {
			throw new Error("Tracked worker background process identity could not be verified");
		}
		if (status === "current") active.push(orphan);
	}
	const signal =
		options.signal ??
		((pid: number) => {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// The identity-aware polling below decides whether cleanup succeeded;
					// signaling is best-effort so an already-exited PID is not an error.
				}
			}
		});
	for (const orphan of active) signal(orphan.pid);
	const timeoutMs = options.timeoutMs ?? 5_000;
	const pollMs = options.pollMs ?? 25;
	const delay =
		options.delay ??
		((milliseconds: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds)));
	const hasLiveIdentity = (): boolean => {
		let current = false;
		for (const orphan of active) {
			const status = identityStatus(orphan);
			if (status === "unknown") {
				throw new Error("Tracked worker background process identity could not be verified after termination");
			}
			if (status === "current") current = true;
		}
		return current;
	};
	const deadline = Date.now() + timeoutMs;
	while (hasLiveIdentity() && Date.now() < deadline) await delay(pollMs);
	if (hasLiveIdentity()) {
		throw new Error("Tracked worker background processes did not terminate within the cleanup deadline");
	}
	return journaled.length;
}
