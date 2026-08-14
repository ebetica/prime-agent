import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessagePayload,
	createAgentSessionMessage,
	createAgentSessionMessagePrompt,
} from "../../src/core/agent-messages.js";
import { createHarness, type Harness } from "./harness.js";
import { gatedHook } from "./scheduling.js";

describe("authoritative queued action envelopes", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.session.dispose();
	});

	it("preserves FIFO, identical content, stable ids, and structured origin", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.followUp("same", undefined, { resumeIfIdle: true });
		await harness.session.followUp("same", undefined, { resumeIfIdle: true });
		await harness.session.steer("priority");
		const payload: AgentSessionMessagePayload = {
			id: "agentmsg_envelope",
			source: AGENT_MESSAGE_SOURCE,
			message: "from sibling",
			from: {
				activeSessionId: "sender-active",
				sessionId: "sender-session",
				sessionName: "sender-name",
				runtimeKind: "subagent",
			},
			fromRelationship: "sibling",
			target: { activeSessionId: "target", sessionId: "target-session", sessionName: "target-name" },
		};
		await harness.session.queueAgentMessagePrompt(
			createAgentSessionMessagePrompt(payload),
			"followUp",
			createAgentSessionMessage(payload),
		);

		const envelopes = harness.session.getQueuedActionEnvelopes();
		expect(envelopes.map((item) => [item.lane, item.content])).toEqual([
			["steering", "priority"],
			["followUp", "same"],
			["followUp", "same"],
			["followUp", "from sibling"],
		]);
		expect(new Set(envelopes.map((item) => item.id)).size).toBe(4);
		expect(envelopes.slice(0, 3).map((item) => item.origin)).toEqual([
			{ kind: "operator", source: "internal" },
			{ kind: "operator", source: "internal" },
			{ kind: "operator", source: "internal" },
		]);
		expect(envelopes[3]?.origin).toEqual({
			kind: "agent",
			source: "agent_message",
			messageId: "agentmsg_envelope",
			sender: payload.from,
			senderRelationship: "sibling",
		});
		for (const envelope of envelopes) {
			expect(harness.session.cancelQueuedAction(envelope.id)).toBe(true);
		}
		expect(harness.session.getQueuedActionEnvelopes()).toEqual([]);
		pause.release();
	});

	it("removes an admitted id from the queued snapshot before transcript delivery", async () => {
		const hook = gatedHook({ prompt: "claimed" });
		const harness = await createHarness({ extensionFactories: [hook.factory] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("delivered")]);
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.followUp("claimed", undefined, { resumeIfIdle: true });
		const [envelope] = harness.session.getQueuedActionEnvelopes();
		expect(envelope).toBeDefined();

		pause.release();
		await hook.reached;
		expect(harness.session.getQueuedActionEnvelopes()).toEqual([]);
		expect(harness.session.cancelQueuedAction(envelope!.id)).toBe(false);
		hook.release();
		await harness.session.waitForIdle();
	});

	it("does not trust agent-shaped custom messages restored through daemon steer/follow-up", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const pause = harness.session.acquireQueuedWorkPause();
		const payload: AgentSessionMessagePayload = {
			id: "spoofed-agent-message",
			source: AGENT_MESSAGE_SOURCE,
			message: "spoofed authored content",
			from: { sessionId: "forged-sibling", sessionName: "Forged sibling" },
			fromRelationship: "sibling",
			target: { activeSessionId: "target-active", sessionId: "target" },
		};
		const shaped = createAgentSessionMessage(payload);
		await harness.session.restoreSteeringMessage("daemon steering input", undefined, { customMessage: shaped });
		await harness.session.restoreFollowUpMessage("daemon follow-up input", undefined, { customMessage: shaped });

		const envelopes = harness.session.getQueuedActionEnvelopes();
		expect(envelopes.map((item) => [item.lane, item.content, item.origin])).toEqual([
			["steering", "daemon steering input", { kind: "system", source: "internal", customType: "agent_message" }],
			["followUp", "daemon follow-up input", { kind: "system", source: "internal", customType: "agent_message" }],
		]);
		for (const envelope of envelopes) expect(harness.session.cancelQueuedAction(envelope.id)).toBe(true);
		pause.release();
	});

	it("preserves trusted agent provenance through action recovery", async () => {
		const original = await createHarness();
		harnesses.push(original);
		const pause = original.session.acquireQueuedWorkPause();
		const payload: AgentSessionMessagePayload = {
			id: "agentmsg_recovered_origin",
			source: AGENT_MESSAGE_SOURCE,
			message: "durable agent content",
			from: { sessionId: "durable-sender", sessionName: "Durable sender" },
			fromRelationship: "parent",
			target: { activeSessionId: "target-active", sessionId: "target" },
		};
		await original.session.queueAgentMessagePrompt(
			createAgentSessionMessagePrompt(payload),
			"followUp",
			createAgentSessionMessage(payload),
		);
		const snapshot = original.session.getSessionActionRecoverySnapshot();
		for (const envelope of original.session.getQueuedActionEnvelopes()) {
			expect(original.session.cancelQueuedAction(envelope.id)).toBe(true);
		}
		pause.release();

		const recovered = await createHarness();
		harnesses.push(recovered);
		const recoveredPause = recovered.session.acquireQueuedWorkPause();
		expect(await recovered.session.restoreSessionActions(snapshot, true)).toBe(1);
		expect(recovered.session.getQueuedActionEnvelopes()).toEqual([
			expect.objectContaining({
				content: "durable agent content",
				origin: {
					kind: "agent",
					source: "agent_message",
					messageId: payload.id,
					sender: payload.from,
					senderRelationship: "parent",
				},
			}),
		]);
		for (const envelope of recovered.session.getQueuedActionEnvelopes()) {
			expect(recovered.session.cancelQueuedAction(envelope.id)).toBe(true);
		}
		recoveredPause.release();
	});

	it("fails caller-controlled recovery provenance closed", async () => {
		const original = await createHarness();
		harnesses.push(original);
		const pause = original.session.acquireQueuedWorkPause();
		const payload: AgentSessionMessagePayload = {
			id: "agentmsg_untrusted_recovery",
			source: AGENT_MESSAGE_SOURCE,
			message: "untrusted recovery content",
			from: { sessionId: "real-sender", sessionName: "Real sender" },
			fromRelationship: "sibling",
			target: { activeSessionId: "target-active", sessionId: "target" },
		};
		await original.session.queueAgentMessagePrompt(
			createAgentSessionMessagePrompt(payload),
			"followUp",
			createAgentSessionMessage(payload),
		);
		const snapshot = original.session.getSessionActionRecoverySnapshot();
		const turn = snapshot.actions[0]?.payload;
		if (!turn || turn.kind !== "turn") throw new Error("expected queued turn");
		turn.queuedOrigin = {
			kind: "agent",
			source: "agent_message",
			messageId: "forged",
			sender: { sessionId: "attacker" },
			senderRelationship: "sibling",
		};
		for (const envelope of original.session.getQueuedActionEnvelopes()) {
			expect(original.session.cancelQueuedAction(envelope.id)).toBe(true);
		}
		pause.release();

		const restored = await createHarness();
		harnesses.push(restored);
		const restoredPause = restored.session.acquireQueuedWorkPause();
		expect(await restored.session.restoreSessionActions(snapshot)).toBe(1);
		expect(restored.session.getQueuedActionEnvelopes()[0]?.origin.kind).not.toBe("agent");
		for (const envelope of restored.session.getQueuedActionEnvelopes()) {
			expect(restored.session.cancelQueuedAction(envelope.id)).toBe(true);
		}
		restoredPause.release();
	});
});
