import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ACCEPTED_AGENT_MESSAGE_ID_LIMIT,
	AcceptedAgentMessageIndex,
} from "../src/core/accepted-agent-message-index.js";
import { createAgentSessionMessage } from "../src/core/agent-messages.js";
import { ParentAgentMessageOutbox } from "../src/core/parent-agent-message-outbox.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "agent-message-journal-"));
	dirs.push(dir);
	return dir;
}

describe("durable agent-message journals", () => {
	it("reconstructs a committed sender row and removes it only after settlement", () => {
		const dir = tempDir();
		new ParentAgentMessageOutbox(dir).commit("agentmsg-1", "reply");
		const recovered = new ParentAgentMessageOutbox(dir);
		expect(recovered.pending()).toMatchObject([{ id: "agentmsg-1", message: "reply", state: "pending" }]);
		expect(() => recovered.commit("agentmsg-1", "different")).toThrow("id collision");
		recovered.markDelivered("agentmsg-1", {
			id: "agentmsg-1",
			source: "agent_message",
			message: "reply",
			deliveryStatus: "delivered",
			target: { activeSessionId: "parent-active", sessionId: "parent" },
		});
		expect(new ParentAgentMessageOutbox(dir).pending()[0]?.state).toBe("delivered");
		recovered.markAcknowledged("agentmsg-1");
		recovered.markDelivered("agentmsg-1", {
			id: "agentmsg-1",
			source: "agent_message",
			message: "reply",
			deliveryStatus: "delivered",
			target: { activeSessionId: "parent-active", sessionId: "parent" },
		});
		expect(recovered.pending()[0]?.state).toBe("acknowledged");
		recovered.clearAcknowledged();
		recovered.closeAdmission();
		const closed = new ParentAgentMessageOutbox(dir);
		expect(closed.pending()).toEqual([]);
		expect(closed.isClosed()).toBe(true);
	});

	it("persists the original receiver status, rejects identity reuse, and stays bounded", () => {
		const dir = tempDir();
		const index = new AcceptedAgentMessageIndex(dir);
		for (let n = 0; n <= ACCEPTED_AGENT_MESSAGE_ID_LIMIT; n += 1) {
			const acceptedMessage = createAgentSessionMessage({
				id: `agentmsg-${n}`,
				source: "agent_message",
				message: `message-${n}`,
				from: { sessionId: "sender" },
				target: { sessionId: "target", activeSessionId: "target-active" },
			});
			index.remember({
				id: acceptedMessage.details.id,
				message: acceptedMessage.details.message,
				fromSessionId: "sender",
				status: "delivered",
				acceptedMessage,
				needsDelivery: false,
				senderAcknowledged: true,
			});
		}
		const recovered = new AcceptedAgentMessageIndex(dir);
		expect(recovered.entries()).toHaveLength(ACCEPTED_AGENT_MESSAGE_ID_LIMIT);
		expect(recovered.find("agentmsg-0")).toBeUndefined();
		expect(recovered.find(`agentmsg-${ACCEPTED_AGENT_MESSAGE_ID_LIMIT}`)?.status).toBe("delivered");
		const last = recovered.find(`agentmsg-${ACCEPTED_AGENT_MESSAGE_ID_LIMIT}`)!;
		expect(() => recovered.remember({ ...last, message: "collision" })).toThrow("id collision");
		recovered.remember({
			...last,
			id: "agentmsg-live",
			message: "live",
			needsDelivery: true,
			senderAcknowledged: false,
		});
		expect(recovered.find("agentmsg-live")?.needsDelivery).toBe(true);
		expect(JSON.parse(readFileSync(recovered.path, "utf8")).entries).toHaveLength(
			ACCEPTED_AGENT_MESSAGE_ID_LIMIT + 1,
		);
	});
});
