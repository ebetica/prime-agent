import { describe, expect, it } from "vitest";
import { type AgentSessionMessageReceipt, createAgentMessageHostHandlers } from "../src/core/agent-messages.js";

describe("agent-message send admission", () => {
	it("admits a parent send before roster resolution and preserves its id", async () => {
		let releaseRoster!: () => void;
		const rosterGate = new Promise<void>((resolve) => {
			releaseRoster = resolve;
		});
		const chronology: string[] = [];
		let admittedId = "";
		const handlers = createAgentMessageHostHandlers({
			admitAgentMessageSend: () => {
				chronology.push("admitted");
				return {
					id: "agentmsg-stable",
					commit: () => chronology.push("durable"),
					resolve: () => {
						chronology.push("committed");
					},
					reject: () => chronology.push("failed"),
				};
			},
			roster: async () => {
				chronology.push("roster-start");
				await rosterGate;
				return {
					current: { id: "child", name: "child", depth: 1 },
					entries: [{ id: "parent", name: "parent", depth: 0, relationship: "parent", status: "idle" }],
				};
			},
			sendAgentMessage: async (input): Promise<AgentSessionMessageReceipt> => {
				admittedId = input.id ?? "";
				chronology.push("transport");
				return {
					id: input.id!,
					source: "agent_message",
					target: { activeSessionId: "parent", sessionId: "parent-session" },
					message: input.message,
					deliveryStatus: "queued",
				};
			},
		});

		const result = handlers["agent_message.send"]!({ message: "done", receiver_role: "parent" });
		await Promise.resolve();
		expect(chronology).toEqual(["admitted", "durable", "roster-start"]);
		releaseRoster();
		await result;
		expect(admittedId).toBe("agentmsg-stable");
		expect(chronology).toEqual(["admitted", "durable", "roster-start", "transport", "committed"]);
	});

	it("durably fails admission when selector resolution rejects", async () => {
		let failed = false;
		const handlers = createAgentMessageHostHandlers({
			admitAgentMessageSend: () => ({
				id: "agentmsg-failed",
				commit: () => {},
				resolve: () => {},
				reject: () => {
					failed = true;
				},
			}),
			roster: async () => ({ current: { id: "child", name: "child", depth: 1 }, entries: [] }),
			sendAgentMessage: async () => {
				throw new Error("not reached");
			},
		});
		await expect(handlers["agent_message.send"]!({ message: "done", receiver_role: "parent" })).rejects.toThrow(
			"No parent matches",
		);
		expect(failed).toBe(true);
	});
});
