import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { OwnedOperationPersistence } from "./owned-operation-registry.js";

export interface DurableStopRecord {
	token: string;
	ownerId: string;
	operationIds: readonly string[];
	kernelRestarted: boolean;
	recordedAt: string;
}

export interface DurableStoppedReceipt extends DurableStopRecord {
	status: "stopped";
}

interface JournalState {
	version: 1;
	pending?: DurableStopRecord;
	terminal: DurableStoppedReceipt[];
}

export interface OwnedOperationJournalOptions {
	maxTerminalReceipts?: number;
	terminalReceiptTtlMs?: number;
	now?: () => number;
}

function emptyState(): JournalState {
	return { version: 1, terminal: [] };
}

function validRecord(value: unknown): value is DurableStopRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<DurableStopRecord>;
	return (
		typeof record.token === "string" &&
		typeof record.ownerId === "string" &&
		Array.isArray(record.operationIds) &&
		record.operationIds.every((id) => typeof id === "string") &&
		typeof record.kernelRestarted === "boolean" &&
		typeof record.recordedAt === "string"
	);
}

async function loadState(path: string): Promise<JournalState> {
	try {
		const value = JSON.parse(await readFile(path, "utf8")) as Partial<JournalState>;
		if (value.version !== 1) return emptyState();
		return {
			version: 1,
			...(validRecord(value.pending) ? { pending: value.pending } : {}),
			terminal: Array.isArray(value.terminal)
				? value.terminal.filter(
						(record): record is DurableStoppedReceipt => validRecord(record) && record.status === "stopped",
					)
				: [],
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
		throw error;
	}
}

/** Atomic replacement with file and parent-directory fsync. */
async function writeDurable(path: string, state: JournalState): Promise<void> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(`${JSON.stringify(state)}\n`, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await rename(temporary, path);
		const parent = await open(directory, "r");
		try {
			await parent.sync();
		} finally {
			await parent.close();
		}
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

/**
 * Bounded durable intent/receipt store. It contains only live stop intent plus a
 * retry window, never an all-time action history.
 */
export class OwnedOperationJournal implements OwnedOperationPersistence {
	private readonly path: string;
	private readonly maxTerminalReceipts: number;
	private readonly terminalReceiptTtlMs: number;
	private readonly now: () => number;
	private state: JournalState;
	private tail: Promise<void> = Promise.resolve();

	private constructor(path: string, state: JournalState, options: OwnedOperationJournalOptions) {
		this.path = path;
		this.state = state;
		this.maxTerminalReceipts = options.maxTerminalReceipts ?? 128;
		this.terminalReceiptTtlMs = options.terminalReceiptTtlMs ?? 24 * 60 * 60 * 1000;
		this.now = options.now ?? Date.now;
		this.prune();
	}

	static async open(path: string, options: OwnedOperationJournalOptions = {}): Promise<OwnedOperationJournal> {
		return new OwnedOperationJournal(path, await loadState(path), options);
	}

	get pending(): DurableStopRecord | undefined {
		return this.state.pending
			? { ...this.state.pending, operationIds: [...this.state.pending.operationIds] }
			: undefined;
	}

	get terminalReceipts(): readonly DurableStoppedReceipt[] {
		return this.state.terminal.map((receipt) => ({ ...receipt, operationIds: [...receipt.operationIds] }));
	}

	writeStopIntent(record: Omit<DurableStopRecord, "recordedAt">): Promise<void> {
		return this.update((state) => {
			if (state.pending && state.pending.token !== record.token) {
				throw new Error("Another durable stop intent is still pending cleanup");
			}
			state.pending = {
				...record,
				operationIds: [...record.operationIds],
				recordedAt: new Date(this.now()).toISOString(),
			};
		});
	}

	writeStopped(record: Omit<DurableStopRecord, "recordedAt">): Promise<void> {
		return this.update((state) => {
			if (state.pending?.token !== record.token) throw new Error("Stopped receipt has no matching durable intent");
			state.pending = undefined;
			state.terminal = state.terminal.filter((receipt) => receipt.token !== record.token);
			state.terminal.push({
				...record,
				operationIds: [...record.operationIds],
				recordedAt: new Date(this.now()).toISOString(),
				status: "stopped",
			});
		});
	}

	/** Reconcile a crash-pending intent; cleanup proof must finish before the durable terminal receipt. */
	async recoverPending(cleanup: (record: DurableStopRecord) => Promise<void>): Promise<boolean> {
		const record = this.pending;
		if (!record) return false;
		await cleanup(record);
		await this.writeStopped(record);
		return true;
	}

	private update(change: (state: JournalState) => void): Promise<void> {
		const run = async () => {
			const next: JournalState = {
				version: 1,
				...(this.state.pending
					? { pending: { ...this.state.pending, operationIds: [...this.state.pending.operationIds] } }
					: {}),
				terminal: this.state.terminal.map((receipt) => ({ ...receipt, operationIds: [...receipt.operationIds] })),
			};
			change(next);
			const previous = this.state;
			this.state = next;
			this.prune();
			try {
				await writeDurable(this.path, this.state);
			} catch (error) {
				this.state = previous;
				throw error;
			}
		};
		const result = this.tail.then(run, run);
		this.tail = result.catch(() => {});
		return result;
	}

	private prune(): void {
		const oldestAllowed = this.now() - this.terminalReceiptTtlMs;
		this.state.terminal = this.state.terminal.filter((receipt) => Date.parse(receipt.recordedAt) >= oldestAllowed);
		if (this.state.terminal.length > this.maxTerminalReceipts) {
			this.state.terminal.splice(0, this.state.terminal.length - this.maxTerminalReceipts);
		}
	}
}
