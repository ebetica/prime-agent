import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./harness.js";
import { withStreaming } from "./scheduling.js";

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

	it("makes matched stop retryable without aborting a replacement run", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const internals = harness.session as unknown as { _activeRunInstanceId?: string; abort(): Promise<void> };
		internals._activeRunInstanceId = "run-a";
		internals.abort = async () => {};
		const run = harness.session.getSessionActionSnapshot().activeRunInstanceId;
		expect(run).toBe("run-a");
		expect(await harness.session.stopActiveRun(run!)).toEqual({ status: "stopped" });
		expect(await harness.session.stopActiveRun(run!)).toEqual({ status: "already_stopped" });
		expect(await harness.session.stopActiveRun("not-the-run")).toEqual({ status: "stale" });
	});
});
