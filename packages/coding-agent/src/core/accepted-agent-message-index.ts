/** Bounded durable idempotency index for accepted agent messages. */
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AgentSessionMessage, AgentSessionMessageDeliveryStatus } from "./agent-messages.js";

const FILE_NAME = "accepted-agent-message-ids.json";
export const ACCEPTED_AGENT_MESSAGE_ID_LIMIT = 256;
export interface AcceptedAgentMessageIdentity {
	id: string;
	message: string;
	fromSessionId?: string;
	status: AgentSessionMessageDeliveryStatus;
	acceptedMessage: AgentSessionMessage;
	needsDelivery: boolean;
	senderAcknowledged: boolean;
}

function load(path: string): AcceptedAgentMessageIdentity[] {
	if (!existsSync(path)) return [];
	const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; entries?: unknown };
	if (value.version !== 1 || !Array.isArray(value.entries))
		throw new Error(`Invalid accepted agent-message index: ${path}`);
	return value.entries.filter((entry): entry is AcceptedAgentMessageIdentity => {
		const candidate = entry as Partial<AcceptedAgentMessageIdentity>;
		return (
			typeof candidate.id === "string" &&
			typeof candidate.message === "string" &&
			(candidate.fromSessionId === undefined || typeof candidate.fromSessionId === "string") &&
			(candidate.status === "queued" || candidate.status === "delivered") &&
			typeof candidate.acceptedMessage === "object"
		);
	});
}

function store(path: string, entries: AcceptedAgentMessageIdentity[]): void {
	mkdirSync(dirname(path), { recursive: true });
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

export class AcceptedAgentMessageIndex {
	readonly path: string;
	constructor(sessionArtifactDir: string) {
		this.path = join(sessionArtifactDir, FILE_NAME);
	}
	entries(): AcceptedAgentMessageIdentity[] {
		return load(this.path);
	}
	find(id: string): AcceptedAgentMessageIdentity | undefined {
		return load(this.path).find((entry) => entry.id === id);
	}
	remember(entry: AcceptedAgentMessageIdentity): void {
		const entries = load(this.path);
		const existing = entries.find((candidate) => candidate.id === entry.id);
		if (existing) {
			if (existing.message !== entry.message || existing.fromSessionId !== entry.fromSessionId) {
				throw new Error(`Agent message id collision: ${entry.id}`);
			}
			store(
				this.path,
				entries.map((candidate) => (candidate.id === entry.id ? entry : candidate)),
			);
			return;
		}
		const next = [...entries, entry];
		const pending = next.filter((candidate) => !candidate.senderAcknowledged);
		const deliveredResidue = next
			.filter((candidate) => candidate.senderAcknowledged)
			.slice(-ACCEPTED_AGENT_MESSAGE_ID_LIMIT);
		store(this.path, [...deliveredResidue, ...pending]);
	}
	forget(id: string): void {
		const entries = load(this.path);
		if (entries.some((entry) => entry.id === id))
			store(
				this.path,
				entries.filter((entry) => entry.id !== id),
			);
	}
}
