import { randomUUID } from "node:crypto";

/** One immutable root operation owns every child effect started by that run. */
export type OwnedOperationKind = "agent_run" | "user_bash";

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
	/** Broad owner cleanup must verify every child/process/kernel effect is gone. */
	cleanup?(): void | Promise<void>;
}

export type StopOwnedOperationResult = { status: "stopped" } | { status: "already_stopped" } | { status: "stale" };

interface RootRecord extends OwnedOperationDescriptor {
	hooks: OwnedOperationHooks;
	snapshot?: OwnedOperationSet;
	stopping?: Promise<StopOwnedOperationResult>;
}

interface TerminalReceipt {
	completion: Promise<StopOwnedOperationResult>;
	createdAt: number;
}

export interface OwnedOperationRegistryOptions {
	maxTerminalReceipts?: number;
	terminalReceiptTtlMs?: number;
	now?: () => number;
}

export class OwnedOperationRegistry {
	private root?: RootRecord;
	private readonly terminal = new Map<string, TerminalReceipt>();
	private readonly maxTerminalReceipts: number;
	private readonly terminalReceiptTtlMs: number;
	private readonly now: () => number;

	constructor(options: OwnedOperationRegistryOptions = {}) {
		this.maxTerminalReceipts = options.maxTerminalReceipts ?? 128;
		this.terminalReceiptTtlMs = options.terminalReceiptTtlMs ?? 24 * 60 * 60 * 1000;
		this.now = options.now ?? Date.now;
	}

	admitRoot(kind: OwnedOperationKind, hooks: OwnedOperationHooks): OwnedOperationDescriptor {
		if (this.root) throw new Error("A conflicting owned operation is already admitted");
		const operation = Object.freeze({ id: randomUUID(), kind });
		this.root = { ...operation, hooks };
		return operation;
	}

	complete(operationId: string): void {
		const root = this.root;
		if (!root || root.id !== operationId || root.stopping) return;
		this.root = undefined;
	}

	activeSet(): OwnedOperationSet | undefined {
		const root = this.root;
		if (!root) return undefined;
		if (root.snapshot) return root.snapshot;
		root.snapshot = Object.freeze({
			token: randomUUID(),
			operations: Object.freeze([Object.freeze({ id: root.id, kind: root.kind })]),
		});
		return root.snapshot;
	}

	async stop(token: string): Promise<StopOwnedOperationResult> {
		this.pruneTerminal();
		const prior = this.terminal.get(token);
		if (prior) {
			const result = await prior.completion;
			return result.status === "stopped" ? { status: "already_stopped" } : result;
		}
		const root = this.root;
		const active = this.activeSet();
		if (!root || !active || active.token !== token) return { status: "stale" };
		if (root.stopping) return root.stopping;

		const completion = (async (): Promise<StopOwnedOperationResult> => {
			const failures: unknown[] = [];
			for (const action of [() => root.hooks.interrupt(), () => root.hooks.settled, () => root.hooks.cleanup?.()]) {
				try {
					await action();
				} catch (error) {
					failures.push(error);
				}
			}
			if (failures.length > 0) throw new AggregateError(failures, "Owned operation cleanup did not settle safely");
			if (this.root === root) this.root = undefined;
			return { status: "stopped" };
		})();
		root.stopping = completion;
		this.terminal.set(token, { completion, createdAt: this.now() });
		this.pruneTerminal();
		return completion;
	}

	get activeOwnerId(): string | undefined {
		return this.root?.id;
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
