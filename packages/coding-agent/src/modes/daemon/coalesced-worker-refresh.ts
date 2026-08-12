/** Coalesces summary refreshes per worker while preserving awaited trigger coverage. */
interface PendingRefresh {
	promise: Promise<void>;
	recovery: boolean;
	resolve: () => void;
	reject: (error: unknown) => void;
}

interface RefreshState {
	running: boolean;
	pending?: PendingRefresh;
}

function pendingRefresh(recovery: boolean): PendingRefresh {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, recovery, resolve, reject };
}

export class CoalescedWorkerRefresh<Worker extends object> {
	private readonly states = new WeakMap<Worker, RefreshState>();

	request(worker: Worker, recovery: boolean, refresh: (recovery: boolean) => Promise<void>): Promise<void> {
		let state = this.states.get(worker);
		if (!state) {
			state = { running: false };
			this.states.set(worker, state);
		}
		if (!state.pending) state.pending = pendingRefresh(recovery);
		else state.pending.recovery ||= recovery;
		const requested = state.pending.promise;
		if (!state.running) void this.drain(worker, state, refresh);
		return requested;
	}

	private async drain(
		worker: Worker,
		state: RefreshState,
		refresh: (recovery: boolean) => Promise<void>,
	): Promise<void> {
		state.running = true;
		while (state.pending) {
			const current = state.pending;
			state.pending = undefined;
			try {
				await refresh(current.recovery);
				current.resolve();
			} catch (error) {
				current.reject(error);
			}
		}
		state.running = false;
		this.states.delete(worker);
	}
}
