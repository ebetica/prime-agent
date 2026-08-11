/**
 * Atomic per-session queue checkpoint.
 *
 * A queued action is durable before its submitter is acknowledged. The runtime
 * rewrites this checkpoint when an action is selected, cancelled, or rolled
 * back, so a replacement process restores only work that was never admitted.
 * Admitted/running work belongs to worker-recovery interruption handling and is
 * deliberately never replayed from this file.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionActionRecoverySnapshot } from "./agent-session.js";

const FILE_NAME = "session-action-queue.json";

export function sessionActionQueuePath(artifactDir: string): string {
	return join(artifactDir, FILE_NAME);
}

export class SessionActionQueueJournal {
	readonly path: string;
	constructor(artifactDir: string) {
		this.path = sessionActionQueuePath(artifactDir);
	}

	read(): SessionActionRecoverySnapshot | undefined {
		try {
			const value = JSON.parse(readFileSync(this.path, "utf8")) as SessionActionRecoverySnapshot;
			if (value.formatVersion !== 1 || !Array.isArray(value.actions)) {
				throw new Error(`Invalid durable session queue: ${this.path}`);
			}
			return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	write(snapshot: SessionActionRecoverySnapshot): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			const descriptor = openSync(temporary, "w", 0o600);
			try {
				writeSync(descriptor, `${JSON.stringify(snapshot)}\n`);
				fsyncSync(descriptor);
			} finally {
				closeSync(descriptor);
			}
			renameSync(temporary, this.path);
			const directoryDescriptor = openSync(dirname(this.path), "r");
			try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
		} catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
	}
}
