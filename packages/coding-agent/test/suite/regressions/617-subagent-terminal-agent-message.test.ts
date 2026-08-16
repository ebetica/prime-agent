import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	AGENT_MESSAGE_CUSTOM_TYPE,
	type AgentSessionMessage,
	createAgentSessionMessage,
} from "../../../src/core/agent-messages.js";
import { createHarness, type Harness } from "../harness.js";

function terminalMessage(messages: readonly unknown[]): AgentSessionMessage | undefined {
	return messages.find(
		(message): message is AgentSessionMessage =>
			typeof message === "object" &&
			message !== null &&
			"role" in message &&
			"customType" in message &&
			(message as { role?: unknown }).role === "custom" &&
			(message as { customType?: unknown }).customType === AGENT_MESSAGE_CUSTOM_TYPE,
	);
}

describe("#617 subagent terminal agent messages", () => {
	let parent: Harness | undefined;
	let child: Harness | undefined;

	afterEach(() => {
		child?.cleanup();
		parent?.cleanup();
		child = undefined;
		parent = undefined;
	});

	it("delivers a child completion without a reply as an attributed agent message", async () => {
		const childSessionName = "terminal-worker";
		child = await createHarness({
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				sendAgentMessage: async (input) => {
					expect(input).toMatchObject({
						target: parent!.session.sessionId,
						message: expect.stringContaining("completed without sending a reply"),
					});
					const message = createAgentSessionMessage({
						id: "agentmsg-terminal-completion",
						source: "agent_message",
						message: input.message,
						from: {
							activeSessionId: "child-active",
							sessionId: child!.session.sessionId,
							sessionName: childSessionName,
						},
						fromRelationship: "child",
						target: { activeSessionId: "parent-active", sessionId: parent!.session.sessionId },
					});
					await parent!.session.acceptAgentMessagePrompt(message.content, { customMessage: message });
					return {
						id: message.details.id,
						source: "agent_message",
						target: { activeSessionId: "parent-active", sessionId: parent!.session.sessionId },
						message: input.message,
						deliveryStatus: "delivered",
					};
				},
			},
		});
		parent = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child!.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		child.setResponses([fauxAssistantMessage("child completed")]);

		const spawned = await parent.session.runRlmChild("finish without replying", { name: childSessionName });

		await expect
			.poll(() => terminalMessage(parent!.session.messages))
			.toMatchObject({
				customType: AGENT_MESSAGE_CUSTOM_TYPE,
				details: {
					id: "agentmsg-terminal-completion",
					fromRelationship: "child",
					from: { sessionId: child.session.sessionId, sessionName: childSessionName },
				},
				content: expect.stringContaining(`[from child:${childSessionName}]`),
			});
		expect(parent.session.messages).not.toContainEqual(
			expect.objectContaining({ customType: "rlm_child_terminal_notice" }),
		);
		expect(terminalMessage(parent.session.messages)?.content).toContain(spawned.rlm_child_id);
	});

	it("drains initial sends before completion without blocking later explicit sends", async () => {
		child = await createHarness();
		parent = await createHarness({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child!.session }),
				deleteRlmSubagentRuntime: async () => {},
			} as never,
		});
		child.setResponses([fauxAssistantMessage("done")]);
		const statuses: string[] = [];
		parent.session.subscribe((event) => {
			if (event.type === "rlm_child_update") statuses.push(event.child.status);
		});
		const gate = child.session as unknown as {
			_admitParentAgentMessageSend(): {
				id: string;
				resolve(receipt: unknown): void;
				reject(error: unknown): void;
			};
		};
		const admission = gate._admitParentAgentMessageSend();
		await parent.session.runRlmChild("finish while reply admission is pending");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(statuses).not.toContain("done");
		expect(
			parent.session.messages.some(
				(message) => "content" in message && String(message.content).includes("completed without sending"),
			),
		).toBe(false);

		admission.resolve({});
		await expect.poll(() => statuses.at(-1)).toBe("done");
		expect(admission.id).toMatch(/^agentmsg_/);
		expect(
			parent.session.messages.some(
				(message) => "content" in message && String(message.content).includes("completed without sending"),
			),
		).toBe(false);
		const retainedAdmission = gate._admitParentAgentMessageSend();
		expect(retainedAdmission.id).toMatch(/^agentmsg_/);
		retainedAdmission.reject(new Error("test cleanup"));
	});

	it("uses truthful fallback after an admitted parent reply durably fails", async () => {
		child = await createHarness();
		parent = await createHarness({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child!.session }),
				deleteRlmSubagentRuntime: async () => {},
			} as never,
		});
		child.setResponses([fauxAssistantMessage("done")]);
		const gate = child.session as unknown as {
			_admitParentAgentMessageSend(): { reject(error: unknown): void };
		};
		const admission = gate._admitParentAgentMessageSend();
		await parent.session.runRlmChild("attempt a reply that fails");
		admission.reject(new Error("delivery rejected"));
		await expect
			.poll(() =>
				parent!.session.messages.some(
					(message) => "content" in message && String(message.content).includes("completed without sending"),
				),
			)
			.toBe(true);
	});

	it("falls back to an injected notice after a definitive agent-message rejection", async () => {
		// A controller that always rejects: the parent must still learn the child
		// finished. Losing the notice entirely is worse than losing attribution.
		child = await createHarness({
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				sendAgentMessage: async () => {
					throw new Error("Agent messaging is paused");
				},
			},
		});
		parent = await createHarness({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child!.session }),
				deleteRlmSubagentRuntime: async () => {},
			} as never,
		});
		child.setResponses([fauxAssistantMessage("done, no reply to parent")]);
		parent.setResponses([fauxAssistantMessage("parent ack")]);

		await parent.session.runRlmChild("do the work");
		await new Promise((resolve) => setTimeout(resolve, 200));

		// The notice arrives some way: either the agent message or the injected
		// fallback, but never silently dropped.
		const sawNotice = parent.session.messages.some((message) => {
			const content = (message as { content?: unknown }).content;
			return typeof content === "string" && content.includes("completed without sending a reply");
		});
		expect(sawNotice || terminalMessage(parent.session.messages) !== undefined).toBe(true);
	}, 60_000);

	it("keeps one stable terminal notice pending after an ambiguous transport failure", async () => {
		child = await createHarness({
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				sendAgentMessage: async () => {
					throw new Error("connection closed after write");
				},
			},
		});
		parent = await createHarness({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child!.session }),
				deleteRlmSubagentRuntime: async () => {},
			} as never,
		});
		child.setResponses([fauxAssistantMessage("done, no reply to parent")]);
		await parent.session.runRlmChild("do the work");
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(terminalMessage(parent.session.messages)).toBeUndefined();
		const outbox = (child.session as unknown as { _parentMessageOutbox?: { pending(): unknown[] } })
			._parentMessageOutbox;
		expect(outbox?.pending()).toHaveLength(1);
	}, 60_000);
});
