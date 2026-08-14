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
	/** Alternate durable writer for storage adapters and deterministic failure tests. */
	durableWriter?: (path: string, state: JournalState) => Promise<void>;
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

function sameIntent(left: DurableStopRecord, right: Omit<DurableStopRecord, "recordedAt">): boolean {
	return (
		left.token === right.token &&
		left.ownerId === right.ownerId &&
		left.kernelRestarted === right.kernelRestarted &&
		left.operationIds.length === right.operationIds.length &&
		left.operationIds.every((id, index) => id === right.operationIds[index])
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

/** A rename completed but parent-directory durability could not be proved. */
class AmbiguousDurableCommitError extends Error {
	constructor(cause: unknown) {
		super("Operation journal rename completed but directory fsync failed", { cause });
		this.name = "AmbiguousDurableCommitError";
	}
}

/** Atomic replacement with file and parent-directory fsync. */
async function writeDurable(path: string, state: JournalState): Promise<void> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	// A fixed sibling bounds crash residue to one file; this journal has one
	// session-lease owner and serializes writes within that owner.
	const temporary = `${path}.tmp`;
	let renamed = false;
	try {
		const file = await open(temporary, "w", 0o600);
		try {
			await file.writeFile(`${JSON.stringify(state)}\n`, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
		renamed = true;
		const parent = await open(directory, "r");
		try {
			await parent.sync();
		} finally {
			await parent.close();
		}
	} catch (error) {
		if (!renamed) await rm(temporary, { force: true });
		if (renamed) throw new AmbiguousDurableCommitError(error);
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
	private readonly durableWriter: (path: string, state: JournalState) => Promise<void>;
	private state: JournalState;
	private tail: Promise<void> = Promise.resolve();
	private writeFenced = false;
	private recovery?: Promise<boolean>;

	private constructor(path: string, state: JournalState, options: OwnedOperationJournalOptions) {
		this.path = path;
		this.state = state;
		this.maxTerminalReceipts = options.maxTerminalReceipts ?? 128;
		this.terminalReceiptTtlMs = options.terminalReceiptTtlMs ?? 24 * 60 * 60 * 1000;
		this.now = options.now ?? Date.now;
		this.durableWriter = options.durableWriter ?? writeDurable;
		this.pruneState(this.state);
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
			if (state.pending) {
				if (!sameIntent(state.pending, record)) {
					throw new Error("Another immutable durable stop intent is still pending cleanup");
				}
				return;
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
			if (!state.pending || !sameIntent(state.pending, record)) {
				throw new Error("Stopped receipt has no matching immutable durable intent");
			}
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

	/** Reconcile a crash-pending intent once; concurrent callers share the same cleanup receipt. */
	recoverPending(cleanup: (record: DurableStopRecord) => Promise<void>): Promise<boolean> {
		if (this.recovery) return this.recovery;
		const run = async () => {
			const record = this.pending;
			if (!record) return false;
			await cleanup(record);
			await this.writeStopped(record);
			return true;
		};
		const recovery = run().finally(() => {
			if (this.recovery === recovery) this.recovery = undefined;
		});
		this.recovery = recovery;
		return recovery;
	}

	private update(change: (state: JournalState) => void): Promise<void> {
		const run = async () => {
			if (this.writeFenced) {
				throw new Error(
					"Operation journal writes are fenced after an ambiguous durable commit; reopen to reconcile",
				);
			}
			const next: JournalState = {
				version: 1,
				...(this.state.pending
					? { pending: { ...this.state.pending, operationIds: [...this.state.pending.operationIds] } }
					: {}),
				terminal: this.state.terminal.map((receipt) => ({ ...receipt, operationIds: [...receipt.operationIds] })),
			};
			change(next);
			this.pruneState(next);
			try {
				await this.durableWriter(this.path, next);
				this.state = next;
			} catch (error) {
				if (error instanceof AmbiguousDurableCommitError) {
					// Rename made `next` externally visible. Keep that conservative state
					// and prohibit further writes until a reopen reconciles durability.
					this.state = next;
					this.writeFenced = true;
				}
				throw error;
			}
		};
		const result = this.tail.then(run, run);
		this.tail = result.catch(() => {});
		return result;
	}

	private pruneState(state: JournalState): void {
		const oldestAllowed = this.now() - this.terminalReceiptTtlMs;
		state.terminal = state.terminal.filter((receipt) => Date.parse(receipt.recordedAt) >= oldestAllowed);
		if (state.terminal.length > this.maxTerminalReceipts) {
			state.terminal.splice(0, state.terminal.length - this.maxTerminalReceipts);
		}
	}
}
