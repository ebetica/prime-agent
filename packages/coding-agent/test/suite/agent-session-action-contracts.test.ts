import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SessionAction, transitionSessionAction } from "../../src/core/session-action-store.js";
import { createHarness, getUserTexts, type Harness } from "./harness.js";
import { createDeferred, createWaitingHarness, gatedHook, withStreaming } from "./scheduling.js";

describe("AgentSession action contracts", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("parses session commands only through prompt provenance", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("literal handled")]);

		await harness.session.prompt("/compact");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === "session_slash_command",
			),
		).toBe(true);

		await harness.session.steer("/compact", undefined, { resumeIfIdle: true });
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["/compact"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("runs input handlers before deciding whether busy submissions enter a queue", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) =>
						event.text === "handled"
							? { action: "handled" }
							: { action: "transform", text: `transformed:${event.text}` },
					);
				},
			],
		});
		harnesses.push(harness);
		withStreaming(harness, true);

		await harness.session.prompt("queued", { streamingBehavior: "followUp" });
		await harness.session.prompt("handled", { streamingBehavior: "followUp" });

		expect(harness.session.getFollowUpMessages()).toEqual(["transformed:queued"]);
		expect(harness.session.queuedActionCount).toBe(1);
		withStreaming(harness, false);
		expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: ["transformed:queued"] });
	});

	it("gives nextTurn delivery precedence over triggerTurn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.sendCustomMessage(
			{ customType: "precedence", content: "context only", display: true },
			{ triggerTurn: true, deliverAs: "nextTurn" },
		);

		expect(harness.session.messages).toEqual([]);
		expect(harness.session.queuedActionCount).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(1);

		await harness.session.prompt("consume context");
		expect(harness.session.messages.map((message) => message.role)).toEqual(["custom", "user", "assistant"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("restores normalized payloads without interception, parsing, or an idle wake", async () => {
		let inputHandlerRuns = 0;
		let extensionCommandRuns = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						inputHandlerRuns++;
						return { action: "transform", text: "rewritten" };
					});
					pi.registerCommand("literal", {
						description: "must stay literal",
						handler: async () => {
							extensionCommandRuns++;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("steer done"), fauxAssistantMessage("follow-up done")]);

		await harness.session.restoreFollowUpMessage("/compact");
		await harness.session.restoreSteeringMessage("/literal keep text");
		await Promise.resolve();

		expect(inputHandlerRuns).toBe(0);
		expect(extensionCommandRuns).toBe(0);
		expect(harness.session.getSteeringMessages()).toEqual(["/literal keep text"]);
		expect(harness.session.getFollowUpMessages()).toEqual(["/compact"]);
		expect(harness.session.messages).toEqual([]);

		expect(harness.session.resumeQueuedWork()).toBe(true);
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["/literal keep text", "/compact"]);
		expect(inputHandlerRuns).toBe(0);
		expect(extensionCommandRuns).toBe(0);
	});

	it("withdraws queued operator messages atomically by stable identity", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		withStreaming(harness, true);
		await harness.session.prompt("same", { streamingBehavior: "followUp" });
		await harness.session.prompt("same", { streamingBehavior: "followUp" });
		await harness.session.prompt("keep", { streamingBehavior: "followUp" });
		const queued = harness.session.getSessionActionSnapshot().queuedUserActions!;
		expect(queued.map((item) => item.text)).toEqual(["same", "same", "keep"]);

		const withdrawn = await harness.session.withdrawQueuedUserActions([queued[1].id]);
		expect(withdrawn).toEqual([queued[1]]);
		expect(harness.session.getSessionActionSnapshot().queuedUserActions).toEqual([queued[0], queued[2]]);
		expect(await harness.session.withdrawQueuedUserActions([queued[1].id])).toEqual([]);
	});

	it("keeps exact IDs withdrawable through selected, preparing, and pre-start committing", async () => {
		for (const state of ["selected", "preparing", "committing"] as const) {
			const harness = await createHarness();
			harnesses.push(harness);
			withStreaming(harness, true);
			await harness.session.prompt(`target-${state}`, { streamingBehavior: "followUp" });
			const target = harness.session.getSessionActionSnapshot().queuedUserActions![0];
			const internals = harness.session as unknown as {
				_acquireSessionActionCommitFence(): Promise<{ release(): void }>;
				_actionStore: { selectFirst(): SessionAction | undefined };
			};
			const fence = await internals._acquireSessionActionCommitFence();
			try {
				const action = internals._actionStore.selectFirst();
				expect(action?.id).toBe(target.id);
				if (action && state !== "selected") transitionSessionAction(action, { state: "preparing" });
				if (action && state === "committing") transitionSessionAction(action, { state: "committing" });
			} finally {
				fence.release();
			}
			expect(harness.session.getSessionActionSnapshot().queuedUserActions).toEqual([target]);
			expect(await harness.session.withdrawQueuedUserActions([target.id])).toEqual([target]);
			withStreaming(harness, false);
		}
	});

	it("publishes an exact ID until agent_start replaces it with a Stop token", async () => {
		const gate = gatedHook({ prompt: "handoff" });
		const holdStarted = createDeferred();
		const holdRelease = createDeferred();
		const hold: AgentTool = {
			name: "hold",
			label: "Hold",
			description: "Keep the admitted run observable",
			parameters: Type.Object({}),
			execute: async () => {
				holdStarted.resolve();
				await holdRelease.promise;
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
		};
		const harness = await createHarness({ extensionFactories: [gate.factory], tools: [hold] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const prompt = harness.session.prompt("handoff");
		await gate.reached;
		const handoff = harness.session.getSessionActionSnapshot();
		expect(handoff.activeOperationSet).toBeUndefined();
		expect(handoff.queuedUserActions).toHaveLength(1);
		const stableId = handoff.queuedUserActions![0].id;
		const observed: ReturnType<typeof harness.session.getSessionActionSnapshot>[] = [handoff];
		const unsubscribe = harness.session.subscribe(() => {
			observed.push(harness.session.getSessionActionSnapshot());
		});

		gate.release();
		await holdStarted.promise;
		unsubscribe();
		const running = harness.session.getSessionActionSnapshot();
		expect(running.activeOperationSet).toBeDefined();
		expect(running.queuedUserActions?.some((action) => action.id === stableId)).toBe(false);
		expect(
			observed.every((snapshot) => {
				const hasToken = snapshot.activeOperationSet !== undefined;
				const hasExactId = snapshot.queuedUserActions?.some((action) => action.id === stableId) === true;
				return hasToken !== hasExactId;
			}),
		).toBe(true);
		holdRelease.resolve();
		await prompt;
	});

	it("lets queued-only withdrawal win without stranding remaining FIFO work", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("initial done"),
			fauxAssistantMessage("remaining delivered"),
		]);
		await waitForToolStart;
		await harness.session.prompt("same", { streamingBehavior: "followUp" });
		await harness.session.prompt("same", { streamingBehavior: "followUp" });
		const queued = harness.session.getSessionActionSnapshot().queuedUserActions!;
		expect(await harness.session.withdrawQueuedUserActions([queued[0].id])).toEqual([queued[0]]);
		expect(harness.session.getSessionActionSnapshot().queuedUserActions).toEqual([queued[1]]);
		releaseToolExecution();
		await promptPromise;
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["start", "same"]);
	});

	it("kills a current root-touched kernel after IPython ends at the background boundary", async () => {
		const waitStarted = createDeferred();
		const waitRelease = createDeferred();
		const ipython: AgentTool = {
			name: "ipython",
			label: "IPython",
			description: "Completed kernel cell fixture",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "cell done" }], details: {} }),
		};
		const wait: AgentTool = {
			name: "wait_after_cell",
			label: "Wait",
			description: "Keep the same root active",
			parameters: Type.Object({}),
			execute: async () => {
				waitStarted.resolve();
				await waitRelease.promise;
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [ipython, wait] });
		harnesses.push(harness);
		const kill = vi.fn(async () => {});
		(
			harness.session as unknown as { _ipythonKernelProvisioner: { kill(): Promise<void> } }
		)._ipythonKernelProvisioner = {
			kill,
		};
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("wait_after_cell", {}), { stopReason: "toolUse" }),
		]);
		const prompt = harness.session.prompt("run then wait");
		await waitStarted.promise;
		const token = harness.session.getSessionActionSnapshot().activeOperationSet?.token;
		const stopping = harness.session.stopActiveOperations(token!);
		waitRelease.resolve();
		expect(await stopping).toEqual({ status: "stopped" });
		await prompt;
		expect(kill).toHaveBeenCalledOnce();
	});

	it("kills only a kernel generation owned by an active IPython tool", async () => {
		const started = createDeferred();
		const release = createDeferred();
		const ipython: AgentTool = {
			name: "ipython",
			label: "IPython",
			description: "Active kernel cell fixture",
			parameters: Type.Object({}),
			execute: async () => {
				started.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [ipython] });
		harnesses.push(harness);
		const kill = vi.fn(async () => {});
		(
			harness.session as unknown as { _ipythonKernelProvisioner: { kill(): Promise<void> } }
		)._ipythonKernelProvisioner = {
			kill,
		};
		harness.setResponses([fauxAssistantMessage(fauxToolCall("ipython", {}), { stopReason: "toolUse" })]);
		const prompt = harness.session.prompt("run cell");
		await started.promise;
		const token = harness.session.getSessionActionSnapshot().activeOperationSet?.token;
		expect(token).toBeDefined();
		const stopping = harness.session.stopActiveOperations(token!);
		release.resolve();
		expect(await stopping).toEqual({ status: "stopped" });
		await prompt;
		expect(kill).toHaveBeenCalledOnce();
	});

	it("preserves an idle kernel touched only by a prior root", async () => {
		const waitStarted = createDeferred();
		const waitRelease = createDeferred();
		const ipython: AgentTool = {
			name: "ipython",
			label: "IPython",
			description: "Prior root kernel fixture",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "idle now" }], details: {} }),
		};
		const wait: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Current non-IPython root",
			parameters: Type.Object({}),
			execute: async () => {
				waitStarted.resolve();
				await waitRelease.promise;
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [ipython, wait] });
		harnesses.push(harness);
		const kill = vi.fn(async () => {});
		(
			harness.session as unknown as { _ipythonKernelProvisioner: { kill(): Promise<void> } }
		)._ipythonKernelProvisioner = {
			kill,
		};
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("prior root done"),
		]);
		await harness.session.prompt("touch kernel first");
		expect(kill).not.toHaveBeenCalled();

		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);
		const prompt = harness.session.prompt("current root");
		await waitStarted.promise;
		const token = harness.session.getSessionActionSnapshot().activeOperationSet?.token;
		const stopping = harness.session.stopActiveOperations(token!);
		waitRelease.resolve();
		expect(await stopping).toEqual({ status: "stopped" });
		await prompt;
		expect(kill).not.toHaveBeenCalled();
	});

	it("keeps an identical queued successor fenced until exact stop settles", async () => {
		const successorStarted = createDeferred();
		const successorRelease = createDeferred();
		const holdSuccessor: AgentTool = {
			name: "hold_successor",
			label: "Hold successor",
			description: "Keep the replacement run active",
			parameters: Type.Object({}),
			execute: async () => {
				successorStarted.resolve();
				await successorRelease.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const waiting = await createWaitingHarness({ tools: [holdSuccessor] });
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("hold_successor", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("successor done"),
		]);
		await waitForToolStart;
		await harness.session.prompt("same", { streamingBehavior: "followUp" });
		const predecessor = harness.session.getSessionActionSnapshot().activeOperationSet?.token;
		expect(predecessor).toBeDefined();

		let stopSettled = false;
		const stopping = harness.session.stopActiveOperations(predecessor!).finally(() => {
			stopSettled = true;
		});
		await Promise.resolve();
		expect(harness.session.getSessionActionSnapshot().queuedUserActions).toHaveLength(1);
		expect(stopSettled).toBe(false);
		releaseToolExecution();
		expect(await stopping).toEqual({ status: "stopped" });
		await promptPromise;

		await successorStarted.promise;
		const replacement = harness.session.getSessionActionSnapshot().activeOperationSet?.token;
		expect(replacement).toBeDefined();
		expect(replacement).not.toBe(predecessor);
		expect(await harness.session.stopActiveOperations(predecessor!)).toEqual({ status: "already_stopped" });
		expect(harness.session.getSessionActionSnapshot().activeOperationSet?.token).toBe(replacement);
		successorRelease.resolve();
		await harness.session.waitForIdle();
	});
});
