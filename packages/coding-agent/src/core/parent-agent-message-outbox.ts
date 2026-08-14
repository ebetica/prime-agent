/** Durable O(live) sender outbox for child-to-parent agent messages. */
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AgentSessionMessageReceipt } from "./agent-messages.js";

const FILE_NAME = "parent-agent-message-outbox.json";
const CLOSED_FILE_NAME = "parent-agent-message-admission-closed";

export interface PendingParentAgentMessage {
	id: string;
	message: string;
	createdAt: string;
	state: "pending" | "delivered" | "acknowledged";
	targetActiveSessionId?: string;
	targetSessionId?: string;
}

function readEntries(path: string): PendingParentAgentMessage[] {
	if (!existsSync(path)) return [];
	const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; entries?: unknown };
	if (value.version !== 1 || !Array.isArray(value.entries))
		throw new Error(`Invalid parent agent-message outbox: ${path}`);
	return value.entries.map((entry) => {
		const candidate = entry as Partial<PendingParentAgentMessage>;
		if (
			typeof candidate.id !== "string" ||
			typeof candidate.message !== "string" ||
			typeof candidate.createdAt !== "string" ||
			(candidate.state !== "pending" && candidate.state !== "delivered" && candidate.state !== "acknowledged")
		) {
			throw new Error(`Invalid parent agent-message outbox entry: ${path}`);
		}
		return candidate as PendingParentAgentMessage;
	});
}

function replaceDurably(path: string, entries: PendingParentAgentMessage[]): void {
	mkdirSync(dirname(path), { recursive: true });
	if (entries.length === 0) {
		if (existsSync(path)) {
			unlinkSync(path);
			const dirFd = openSync(dirname(path), "r");
			try {
				fsyncSync(dirFd);
			} finally {
				closeSync(dirFd);
			}
		}
		return;
	}
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify({ version: 1, entries })}\n`, { mode: 0o600 });
	const fd = openSync(temporary, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
	const dirFd = openSync(dirname(path), "r");
	try {
		fsyncSync(dirFd);
	} finally {
		closeSync(dirFd);
	}
}

export class ParentAgentMessageOutbox {
	readonly path: string;
	readonly closedPath: string;
	constructor(sessionDir: string) {
		this.path = join(sessionDir, FILE_NAME);
		this.closedPath = join(sessionDir, CLOSED_FILE_NAME);
	}
	isClosed(): boolean {
		return existsSync(this.closedPath);
	}
	closeAdmission(): void {
		mkdirSync(dirname(this.closedPath), { recursive: true });
		writeFileSync(this.closedPath, "closed\n", { mode: 0o600 });
		const fd = openSync(this.closedPath, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		const dirFd = openSync(dirname(this.closedPath), "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
	}
	pending(): PendingParentAgentMessage[] {
		return readEntries(this.path);
	}
	commit(id: string, message: string): void {
		const entries = readEntries(this.path);
		const existing = entries.find((entry) => entry.id === id);
		if (existing) {
			if (existing.message !== message) throw new Error(`Agent message id collision: ${id}`);
			return;
		}
		replaceDurably(this.path, [...entries, { id, message, createdAt: new Date().toISOString(), state: "pending" }]);
	}
	markDelivered(id: string, receipt: AgentSessionMessageReceipt): void {
		const entries = readEntries(this.path);
		const existing = entries.find((entry) => entry.id === id);
		if (!existing || existing.state === "delivered" || existing.state === "acknowledged") return;
		replaceDurably(
			this.path,
			entries.map((entry) =>
				entry.id === id
					? {
							...entry,
							state: "delivered",
							targetActiveSessionId: receipt.target.activeSessionId,
							targetSessionId: receipt.target.sessionId,
						}
					: entry,
			),
		);
	}
	markAcknowledged(id: string): void {
		const entries = readEntries(this.path);
		const existing = entries.find((entry) => entry.id === id);
		if (!existing || existing.state === "acknowledged") return;
		replaceDurably(
			this.path,
			entries.map((entry) => (entry.id === id ? { ...entry, state: "acknowledged" } : entry)),
		);
	}
	clearAcknowledged(): void {
		const entries = readEntries(this.path);
		replaceDurably(
			this.path,
			entries.filter((entry) => entry.state !== "acknowledged"),
		);
	}
	settle(id: string): void {
		const entries = readEntries(this.path);
		if (!entries.some((entry) => entry.id === id)) return;
		replaceDurably(
			this.path,
			entries.filter((entry) => entry.id !== id),
		);
	}
}

export type RecoverParentAgentMessage = (entry: PendingParentAgentMessage) => Promise<AgentSessionMessageReceipt>;
