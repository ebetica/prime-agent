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
});
