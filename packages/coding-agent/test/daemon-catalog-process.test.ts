import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { type SessionInfo, SessionManager } from "../src/core/session-manager.js";
import {
<<<<<<< HEAD
	appendInterruptedToolResults,
	listSavedSessionSiblings,
=======
	listSavedSessionSiblings,
	reconcileInterruptedRlmChild,
>>>>>>> a5bccfca (fix(coding-agent): reconcile crashed RLM children)
	resolveCatalogSessionMatch,
} from "../src/modes/daemon/daemon-catalog-process.js";

function session(id: string, name: string | undefined, path: string): SessionInfo {
	return {
		id,
		name,
		path,
		cwd: "/tmp/project",
		rlmDepth: 0,
		created: new Date(0),
		modified: new Date(0),
		messageCount: 0,
		firstMessage: "",
		allMessagesText: "",
	};
}

describe("daemon catalog selector resolution", () => {
	it("reads only a saved child's persisted sibling set", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-siblings-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession();
		parent.appendSessionInfo("parent");
		const first = SessionManager.create(root, join(root, "first"));
		first.newSession({ parentSession: parent.getSessionFile(), rlmDepth: 1 });
		first.appendSessionInfo("first");
		const second = SessionManager.create(root, join(root, "second"));
		second.newSession({ parentSession: parent.getSessionFile(), rlmDepth: 1 });
		second.appendSessionInfo("second");
		const registry = join(dirname(sessionDir), "session-artifacts", parent.getSessionId(), "rlm-subagents.jsonl");
		mkdirSync(dirname(registry), { recursive: true });
		writeFileSync(
			registry,
			[
				{ type: "rlm_subagent", childId: "first", sessionFile: first.getSessionFile(), status: "completed" },
				{ type: "rlm_subagent", childId: "second", sessionFile: second.getSessionFile(), status: "completed" },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
		);

		await expect(listSavedSessionSiblings(first.getSessionFile()!)).resolves.toEqual([
			expect.objectContaining({ id: first.getSessionId(), name: "first" }),
			expect.objectContaining({ id: second.getSessionId(), name: "second" }),
		]);
	});

	it("resolves relative parent headers from each child session directory", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-relative-siblings-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession();
		parent.appendSessionInfo("parent");
		const parentFile = parent.getSessionFile()!;
		const firstDir = join(root, "first");
		const first = SessionManager.create(root, firstDir);
		first.newSession({ parentSession: relative(firstDir, parentFile), rlmDepth: 1 });
		first.appendSessionInfo("first");
		const secondDir = join(root, "second");
		const second = SessionManager.create(root, secondDir);
		second.newSession({ parentSession: relative(secondDir, parentFile), rlmDepth: 1 });
		second.appendSessionInfo("second");
		const registry = join(dirname(sessionDir), "session-artifacts", parent.getSessionId(), "rlm-subagents.jsonl");
		mkdirSync(dirname(registry), { recursive: true });
		writeFileSync(
			registry,
			[
				{ type: "rlm_subagent", childId: "first", sessionFile: first.getSessionFile(), status: "completed" },
				{ type: "rlm_subagent", childId: "second", sessionFile: second.getSessionFile(), status: "completed" },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
		);

		await expect(listSavedSessionSiblings(first.getSessionFile()!)).resolves.toEqual([
			expect.objectContaining({ id: first.getSessionId(), name: "first" }),
			expect.objectContaining({ id: second.getSessionId(), name: "second" }),
		]);
	});

	it("treats an exact name colliding with another session id prefix as ambiguous", () => {
		const sessions = [
			session("named-session-id", "target", "/tmp/by-name.jsonl"),
			session("target-prefix-id", "other", "/tmp/by-prefix.jsonl"),
		];

		expect(() => resolveCatalogSessionMatch(sessions, "target")).toThrow('Ambiguous session selector "target"');
	});
	describe("interrupted RLM reconciliation", () => {
		function fixture(status: "running" | "completed") {
			const root = mkdtempSync(join(tmpdir(), "prime-catalog-interrupted-"));
			const sessionDir = join(root, "sessions");
			const parent = SessionManager.create(root, sessionDir);
			parent.newSession();
			parent.appendSessionInfo("parent");
			const childDir = join(root, "child");
			const child = SessionManager.create(root, childDir);
			child.newSession({ parentSession: parent.getSessionFile(), rlmDepth: 1 });
			child.appendSessionInfo("child");
			const registry = join(dirname(sessionDir), "session-artifacts", parent.getSessionId(), "rlm-subagents.jsonl");
			mkdirSync(dirname(registry), { recursive: true });
			writeFileSync(
				registry,
				`${JSON.stringify({
					type: "rlm_subagent",
					childId: "sub-crashed",
					sessionName: "child",
					sessionDir: childDir,
					sessionFile: child.getSessionFile(),
					status,
					updatedAt: new Date(0).toISOString(),
				})}\n`,
			);
			return { parent, child, registry };
		}

		it("appends one interrupted terminal transition and one truthful parent notice", () => {
			const { parent, child, registry } = fixture("running");

			expect(reconcileInterruptedRlmChild(child.getSessionFile()!)).toBe(true);
			expect(reconcileInterruptedRlmChild(child.getSessionFile()!)).toBe(false);

			const rows = readFileSync(registry, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { status: string });
			expect(rows.map((row) => row.status)).toEqual(["interrupted"]);
			const notices = SessionManager.open(parent.getSessionFile()!)
				.getEntries()
				.filter(
					(entry) => entry.type === "custom_message" && entry.customType === "prime-agent.rlm_child_interrupted",
				);
			expect(notices).toHaveLength(1);
			expect(notices[0]).toMatchObject({
				content: expect.stringContaining("Uncertain work was not replayed"),
				details: { childId: "sub-crashed", reason: "worker_interrupted", replayed: false },
			});
		});

		it("does not rewrite a genuinely completed child", () => {
			const { child, registry } = fixture("completed");
			const before = readFileSync(registry, "utf8");
			expect(reconcileInterruptedRlmChild(child.getSessionFile()!)).toBe(false);
			expect(readFileSync(registry, "utf8")).toBe(before);
		});
	});
});

describe("daemon catalog interrupted tool recovery", () => {
	function assistantWithTools(...tools: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) {
		return {
			role: "assistant" as const,
			content: tools.map((tool) => ({ type: "toolCall" as const, ...tool })),
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse" as const,
			timestamp: 1,
		};
	}

	it("terminally fails an orphaned RLM admission without consulting a child edge", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-orphaned-rlm-"));
		const manager = SessionManager.create(root, join(root, "sessions"));
		manager.newSession();
		manager.appendMessage(
			assistantWithTools({ id: "call-rlm", name: "ipython", arguments: { code: 'await rlm("review")' } }),
		);
		const artifactDir = manager.getSessionArtifactDir();
		if (!artifactDir) throw new Error("Missing artifact directory");
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(join(artifactDir, "rlm-subagents.jsonl"), "not-json\n");

		expect(appendInterruptedToolResults(manager)).toEqual(["call-rlm"]);
		const result = manager.buildSessionContext().messages.at(-1);
		expect(result).toMatchObject({
			role: "toolResult",
			toolCallId: "call-rlm",
			toolName: "ipython",
			isError: true,
		});
		if (result?.role !== "toolResult") throw new Error("Missing recovered tool result");
		expect(result.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("was not replayed") }),
		]);
		expect(appendInterruptedToolResults(manager)).toEqual([]);
	});

	it("fails only missing results in a partially persisted tool batch", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-partial-tools-"));
		const manager = SessionManager.create(root, join(root, "sessions"));
		manager.newSession();
		manager.appendMessage(
			assistantWithTools(
				{ id: "healthy", name: "first", arguments: {} },
				{ id: "orphaned", name: "ipython", arguments: { code: "await rlm(task)" } },
			),
		);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "healthy",
			toolName: "first",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: 2,
		});

		expect(appendInterruptedToolResults(manager)).toEqual(["orphaned"]);
		expect(
			manager
				.buildSessionContext()
				.messages.filter((message) => message.role === "toolResult")
				.map((message) => message.toolCallId),
		).toEqual(["healthy", "orphaned"]);
	});

	it("leaves a healthy completed tool batch unchanged", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-complete-tools-"));
		const manager = SessionManager.create(root, join(root, "sessions"));
		manager.newSession();
		manager.appendMessage(assistantWithTools({ id: "complete", name: "ipython", arguments: { code: "1 + 1" } }));
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "complete",
			toolName: "ipython",
			content: [{ type: "text", text: "2" }],
			isError: false,
			timestamp: 2,
		});

		expect(appendInterruptedToolResults(manager)).toEqual([]);
		expect(manager.buildSessionContext().messages).toHaveLength(2);
	});
});
