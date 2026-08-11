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

export interface SessionActionQueueCheckpoint {
	formatVersion: 1;
	queue: SessionActionRecoverySnapshot;
	admitted: SessionActionRecoverySnapshot;
}

export function sessionActionQueuePath(artifactDir: string): string {
	return join(artifactDir, FILE_NAME);
}

export class SessionActionQueueJournal {
	readonly path: string;
	constructor(artifactDir: string) {
		this.path = sessionActionQueuePath(artifactDir);
	}

	read(): SessionActionQueueCheckpoint | undefined {
		try {
			const value = JSON.parse(readFileSync(this.path, "utf8")) as SessionActionQueueCheckpoint;
			if (
				value.formatVersion !== 1 ||
				value.queue?.formatVersion !== 1 ||
				!Array.isArray(value.queue.actions) ||
				value.admitted?.formatVersion !== 1 ||
				!Array.isArray(value.admitted.actions)
			) {
				throw new Error(`Invalid durable session queue: ${this.path}`);
			}
			return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	write(checkpoint: SessionActionQueueCheckpoint): void {
		if (checkpoint.queue.actions.length === 0 && checkpoint.admitted.actions.length === 0) {
			rmSync(this.path, { force: true });
			try {
				const descriptor = openSync(dirname(this.path), "r");
				try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			return;
		}
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			const descriptor = openSync(temporary, "w", 0o600);
			try {
				writeSync(descriptor, `${JSON.stringify(checkpoint)}\n`);
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
