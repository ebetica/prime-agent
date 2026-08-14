import { randomUUID } from "node:crypto";

/**
 * Session-local ownership for exact Stop. One conflicting root operation may be
 * admitted at a time; every child is explicitly attached to that immutable root
 * owner rather than inferred from timing or process ancestry.
 */
export type OwnedOperationKind = "agent_run" | "user_bash" | "kernel_cell" | "subprocess";

export interface OwnedOperationDescriptor {
	id: string;
	kind: OwnedOperationKind;
}

export interface OwnedOperationSet {
	token: string;
	operations: readonly OwnedOperationDescriptor[];
}

export interface OwnedOperationHooks {
	interrupt(): void | Promise<void>;
	settled: Promise<void>;
	cleanup?(): void | Promise<void>;
}

export interface OwnedOperationPersistence {
	writeStopIntent(record: {
		token: string;
		ownerId: string;
		operationIds: readonly string[];
		kernelRestarted: boolean;
	}): Promise<void>;
	writeStopped(record: {
		token: string;
		ownerId: string;
		operationIds: readonly string[];
		kernelRestarted: boolean;
	}): Promise<void>;
}

export type StopOwnedOperationResult =
	| { status: "stopped"; kernelRestarted: boolean }
	| { status: "already_stopped"; kernelRestarted: boolean }
	| { status: "stale" };

interface OperationRecord extends OwnedOperationDescriptor {
	ownerId: string;
	hooks: OwnedOperationHooks;
}

interface RootRecord {
	ownerId: string;
	operations: Map<string, OperationRecord>;
	version: number;
	admissionClosed: boolean;
	snapshot?: { version: number; value: OwnedOperationSet };
	stopping?: Promise<StopOwnedOperationResult>;
}

interface TerminalReceipt {
	completion: Promise<StopOwnedOperationResult>;
	createdAt: number;
}

export interface OwnedOperationRegistryOptions {
	persistence?: OwnedOperationPersistence;
	terminalReceipts?: readonly { token: string; kernelRestarted: boolean; recordedAt: string }[];
	maxTerminalReceipts?: number;
	terminalReceiptTtlMs?: number;
	now?: () => number;
}

export class OwnedOperationRegistry {
	private root?: RootRecord;
	private readonly terminal = new Map<string, TerminalReceipt>();
	private readonly persistence?: OwnedOperationPersistence;
	private readonly maxTerminalReceipts: number;
	private readonly terminalReceiptTtlMs: number;
	private readonly now: () => number;

	constructor(options: OwnedOperationRegistryOptions = {}) {
		this.persistence = options.persistence;
		this.maxTerminalReceipts = options.maxTerminalReceipts ?? 128;
		this.terminalReceiptTtlMs = options.terminalReceiptTtlMs ?? 24 * 60 * 60 * 1000;
		this.now = options.now ?? Date.now;
		for (const receipt of options.terminalReceipts ?? []) {
			this.terminal.set(receipt.token, {
				completion: Promise.resolve({ status: "stopped", kernelRestarted: receipt.kernelRestarted }),
				createdAt: Date.parse(receipt.recordedAt),
			});
		}
		this.pruneTerminal();
	}

	admitRoot(kind: Exclude<OwnedOperationKind, "subprocess">, hooks: OwnedOperationHooks): OwnedOperationDescriptor {
		if (this.root) throw new Error("A conflicting owned operation is already admitted");
		const ownerId = randomUUID();
		const operation = Object.freeze({ id: ownerId, kind });
		this.root = {
			ownerId,
			operations: new Map([[ownerId, { ...operation, ownerId, hooks }]]),
			version: 1,
			admissionClosed: false,
		};
		return operation;
	}

	admitChild(ownerId: string, kind: OwnedOperationKind, hooks: OwnedOperationHooks): OwnedOperationDescriptor {
		const root = this.root;
		if (!root || root.ownerId !== ownerId || root.admissionClosed || root.stopping) {
			throw new Error("Owned operation admission is closed");
		}
		const operation = Object.freeze({ id: randomUUID(), kind });
		root.operations.set(operation.id, { ...operation, ownerId, hooks });
		root.version++;
		root.snapshot = undefined;
		return operation;
	}

	complete(operationId: string): void {
		const root = this.root;
		if (!root || root.stopping) return;
		if (!root.operations.delete(operationId)) return;
		if (operationId === root.ownerId) root.admissionClosed = true;
		if (root.operations.size === 0) {
			this.root = undefined;
			return;
		}
		root.version++;
		root.snapshot = undefined;
	}

	activeSet(): OwnedOperationSet | undefined {
		const root = this.root;
		if (!root) return undefined;
		if (root.snapshot?.version === root.version) return root.snapshot.value;
		const operations = Object.freeze(
			[...root.operations.values()].map(({ id, kind }) => Object.freeze({ id, kind })),
		);
		const value = Object.freeze({ token: randomUUID(), operations });
		root.snapshot = { version: root.version, value };
		return value;
	}

	async stop(token: string): Promise<StopOwnedOperationResult> {
		this.pruneTerminal();
		const prior = this.terminal.get(token);
		if (prior) {
			const result = await prior.completion;
			return result.status === "stopped"
				? { status: "already_stopped", kernelRestarted: result.kernelRestarted }
				: result;
		}
		const root = this.root;
		const active = this.activeSet();
		if (!root || !active || active.token !== token) return { status: "stale" };
		if (root.stopping) return root.stopping;

		root.admissionClosed = true;
		const records = [...root.operations.values()];
		const operationIds = Object.freeze(records.map((record) => record.id));
		const kernelRestarted = records.some((record) => record.kind === "kernel_cell");
		const completion = (async (): Promise<StopOwnedOperationResult> => {
			await this.persistence?.writeStopIntent({ token, ownerId: root.ownerId, operationIds, kernelRestarted });
			const failures: unknown[] = [];
			const collect = (results: PromiseSettledResult<void>[]) => {
				for (const result of results) if (result.status === "rejected") failures.push(result.reason);
			};
			collect(await Promise.allSettled(records.map(async (record) => await record.hooks.interrupt())));
			collect(await Promise.allSettled(records.map(async (record) => await record.hooks.settled)));
			collect(await Promise.allSettled(records.map(async (record) => await record.hooks.cleanup?.())));
			if (failures.length > 0) throw new AggregateError(failures, "Owned operation cleanup did not settle safely");
			await this.persistence?.writeStopped({ token, ownerId: root.ownerId, operationIds, kernelRestarted });
			if (this.root === root) this.root = undefined;
			return { status: "stopped", kernelRestarted };
		})();
		root.stopping = completion;
		this.terminal.set(token, { completion, createdAt: this.now() });
		this.pruneTerminal();
		return completion;
	}

	get activeOwnerId(): string | undefined {
		return this.root?.ownerId;
	}

	get isStopping(): boolean {
		return this.root?.stopping !== undefined;
	}

	private pruneTerminal(): void {
		const oldestAllowed = this.now() - this.terminalReceiptTtlMs;
		for (const [token, receipt] of this.terminal) {
			if (receipt.createdAt < oldestAllowed) this.terminal.delete(token);
		}
		while (this.terminal.size > this.maxTerminalReceipts) {
			const oldest = this.terminal.keys().next().value;
			if (oldest === undefined) break;
			this.terminal.delete(oldest);
		}
	}
}
