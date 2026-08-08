import { EventEmitter } from "node:events";

export interface EventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface EventBusController extends EventBus {
	clear(): void;
}

export function createEventBus(): EventBusController {
	const emitter = new EventEmitter();
	return {
		emit: (channel, data) => {
			emitter.emit(channel, data);
		},
		on: (channel, handler) => {
			const safeHandler = async (data: unknown) => {
				try {
					await handler(data);
				} catch (err) {
					console.error(`Event handler error (${channel}):`, err);
				}
			};
			emitter.on(channel, safeHandler);
			return () => emitter.off(channel, safeHandler);
		},
		clear: () => {
			emitter.removeAllListeners();
		},
	};
}

export interface StagedEventBus {
	readonly bus: EventBus;
	/** Route future events and subscriptions through the live bus. */
	commit(): void;
	/** Remove every staged or adopted subscription. */
	dispose(): void;
}

/**
 * Isolates load-time extension subscriptions until their resource transaction commits.
 * The wrapper remains the extension-facing bus after commit, so later subscriptions
 * and emissions transparently use the live session bus.
 */
export function createStagedEventBus(live: EventBus): StagedEventBus {
	const staged = createEventBus();
	const subscriptions = new Set<{
		channel: string;
		handler: (data: unknown) => void;
		unsubscribe: () => void;
	}>();
	let committed = false;
	let disposed = false;
	const bus: EventBus = {
		emit(channel, data) {
			if (disposed) return;
			(committed ? live : staged).emit(channel, data);
		},
		on(channel, handler) {
			if (disposed) return () => {};
			const subscription = {
				channel,
				handler,
				unsubscribe: (committed ? live : staged).on(channel, handler),
			};
			subscriptions.add(subscription);
			return () => {
				if (!subscriptions.delete(subscription)) return;
				subscription.unsubscribe();
			};
		},
	};
	return {
		bus,
		commit() {
			if (disposed || committed) return;
			committed = true;
			for (const subscription of subscriptions) {
				subscription.unsubscribe();
				subscription.unsubscribe = live.on(subscription.channel, subscription.handler);
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const subscription of subscriptions) subscription.unsubscribe();
			subscriptions.clear();
			staged.clear();
		},
	};
}
