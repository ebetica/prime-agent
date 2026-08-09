import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	collectDaemonLaunchEnv,
	createDaemonCommandEnvelope,
	createDaemonEventEnvelope,
	createDaemonEventMeta,
	createDaemonReplayInfo,
	DAEMON_COMMAND_COMPATIBILITY,
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_OUTBOUND_COMPATIBILITY,
	DAEMON_PROTOCOL_INFO,
	DAEMON_PROTOCOL_VERSION,
	DAEMON_SCHEMA_ID,
	DAEMON_SCHEMA_REVISION,
	type DaemonCommand,
	type DaemonOutbound,
	getDaemonCommandCompatibilities,
	isDaemonCommandEnvelope,
	isDaemonMutatingCommand,
	QUEUED_ACTION_CANCELLATION_COMMAND_TYPES,
	salvageDaemonCommandId,
} from "../src/modes/daemon/daemon-protocol.js";

describe("daemon protocol helpers", () => {
	it("keeps the advertised schema identity synchronized with wire type shapes", () => {
		const source = readFileSync(resolve(__dirname, "../src/modes/daemon/daemon-protocol.ts"), "utf8");
		const commandSource = source.slice(
			source.indexOf("export type DaemonCommand ="),
			source.indexOf("type DaemonCommandName"),
		);
		const savedSessionSource = source.slice(
			source.indexOf("export interface DaemonSavedSessionInfo"),
			source.indexOf("export type DaemonDeleteSavedSessionResult"),
		);
		const outboundSource = source.slice(
			source.indexOf("export type DaemonOutbound ="),
			source.indexOf("export const DAEMON_OUTBOUND_COMPATIBILITY"),
		);
		const digest = createHash("sha256")
			.update(`${commandSource}\n${savedSessionSource}\n${outboundSource}`)
			.digest("hex")
			.slice(0, 12);
		expect(DAEMON_SCHEMA_ID).toBe(`protocol-${DAEMON_PROTOCOL_VERSION}-schema-${DAEMON_SCHEMA_REVISION}-${digest}`);
	});

	it("keeps credential variables out of automatically collected launch overrides", () => {
		expect(
			collectDaemonLaunchEnv({
				PATH: "/trusted/bin",
				RECURSE_MODEL_POLICY: "policy",
				ANTHROPIC_API_KEY: "secret",
				SESSION_TOKEN: "secret",
				GITHUB_PAT: "secret",
				GOOGLE_APPLICATION_CREDENTIALS: "/secret.json",
				PGPASSFILE: "/secret",
				NETRC: "/secret",
				NPM_CONFIG_REGISTRY_AUTH: "secret",
				PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN: "internal",
			}),
		).toEqual({ PATH: "/trusted/bin", RECURSE_MODEL_POLICY: "policy" });
	});

	it("requires atomic reload compatibility only when idle admission is requested", () => {
		expect(
			getDaemonCommandCompatibilities({ type: "reload", activeSessionId: "active-1", ifIdle: true }),
		).toContainEqual({ minProtocol: 7, minSchemaRevision: 14, capability: "atomic_reload" });
		expect(getDaemonCommandCompatibilities({ type: "reload", activeSessionId: "active-1" })).toEqual([
			{ minProtocol: 7 },
		]);
	});

	it("separately gates transactional resource replacement", () => {
		const resources = { contextDirectories: ["/tmp/context"], extensions: ["extension.ts"] };
		expect(
			getDaemonCommandCompatibilities({
				type: "reload",
				activeSessionId: "active-1",
				ifIdle: true,
				resources,
			}),
		).toEqual(
			expect.arrayContaining([
				{ minProtocol: 7, minSchemaRevision: 14, capability: "atomic_reload" },
				{ minProtocol: 7, minSchemaRevision: 16, capability: "atomic_resource_reload" },
			]),
		);
		expect(
			getDaemonCommandCompatibilities({ type: "reload", activeSessionId: "active-1", resources: {} }),
		).toContainEqual({ minProtocol: 7, minSchemaRevision: 16, capability: "atomic_resource_reload" });
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("atomic_resource_reload");
	});

	it("capability-gates durable planned restart handoffs", () => {
		const compatibility = { minProtocol: 7, minSchemaRevision: 17, capability: "planned_restart_handoff" };
		expect(DAEMON_COMMAND_COMPATIBILITY.register_planned_restart_handoff).toEqual(compatibility);
		expect(DAEMON_COMMAND_COMPATIBILITY.restore_planned_restart_handoff).toEqual(compatibility);
		expect(
			getDaemonCommandCompatibilities({ type: "prepare_update_restart", handoffRequestId: "restart-1" }),
		).toContainEqual(compatibility);
		expect(getDaemonCommandCompatibilities({ type: "prepare_update_restart" })).toEqual([{ minProtocol: 7 }]);
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("planned_restart_handoff");
		const lifecycle = { minProtocol: 7, minSchemaRevision: 18, capability: "planned_restart_handoff_lifecycle" };
		expect(DAEMON_COMMAND_COMPATIBILITY.cancel_planned_restart_handoff).toEqual(lifecycle);
		expect(DAEMON_COMMAND_COMPATIBILITY.acknowledge_planned_restart_handoff).toEqual(lifecycle);
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("planned_restart_handoff_lifecycle");
	});

	it("requires compatibility metadata for the heartbeat protocol surface", () => {
		expect(DAEMON_PROTOCOL_VERSION).toBe(7);
		expect(DAEMON_SCHEMA_ID).toContain(`protocol-${DAEMON_PROTOCOL_VERSION}`);
		expect(DAEMON_COMMAND_COMPATIBILITY.heartbeats_list).toEqual({
			minProtocol: 7,
			capability: "heartbeat_catalog",
		});
		expect(DAEMON_COMMAND_COMPATIBILITY.heartbeat_manage).toEqual({
			minProtocol: 7,
			capability: "heartbeat_management",
		});
		expect(DAEMON_COMMAND_COMPATIBILITY.complete_owned_session).toEqual({
			minProtocol: 7,
			capability: "client_owned_sessions",
		});
		expect(DAEMON_OUTBOUND_COMPATIBILITY.heartbeats_changed).toEqual({
			minProtocol: 7,
			capability: "heartbeat_catalog",
		});
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toEqual(
			expect.arrayContaining(["heartbeat_catalog", "heartbeat_management"]),
		);
	});

	it("capability-gates explicit subagent deletion instead of schema-gating it", () => {
		expect(DAEMON_COMMAND_COMPATIBILITY.delete_rlm_subagent).toEqual({
			minProtocol: 7,
			capability: "delete_rlm_subagent",
		});
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("delete_rlm_subagent");
	});

	it("capability-gates the optional model catalog surface", () => {
		expect(DAEMON_COMMAND_COMPATIBILITY.get_model_catalog).toEqual({
			minProtocol: 7,
			capability: "model_catalog",
		});
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("model_catalog");
	});

	it("capability- and schema-gates queued message mutation at its introducing revision", () => {
		expect(DAEMON_COMMAND_COMPATIBILITY.mutate_queued_message).toEqual({
			minProtocol: 7,
			minSchemaRevision: 15,
			capability: "queue_message_mutation",
		});
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("queue_message_mutation");
	});

	it("schema-gates the RLM max depth commands at their introducing revision", () => {
		expect(DAEMON_COMMAND_COMPATIBILITY.get_rlm_max_depth_status).toEqual({ minProtocol: 7, minSchemaRevision: 11 });
		expect(DAEMON_COMMAND_COMPATIBILITY.set_rlm_max_depth).toEqual({ minProtocol: 7, minSchemaRevision: 11 });
	});

	it("schema-gates session commands that carry the telemetry policy", () => {
		expect(getDaemonCommandCompatibilities({ type: "create", config: { cwd: "/tmp" } })).toEqual([
			{ minProtocol: 7 },
		]);
		expect(
			getDaemonCommandCompatibilities({ type: "create", config: { cwd: "/tmp", telemetryDisabled: true } }),
		).toEqual([{ minProtocol: 7, minSchemaRevision: 14 }, { minProtocol: 7 }]);
		expect(getDaemonCommandCompatibilities({ type: "attach", activeSessionId: "active-1" })).toEqual([
			{ minProtocol: 7 },
		]);
		expect(
			getDaemonCommandCompatibilities({ type: "attach", activeSessionId: "active-1", telemetryDisabled: true }),
		).toEqual([{ minProtocol: 7, minSchemaRevision: 14 }, { minProtocol: 7 }]);
		expect(
			getDaemonCommandCompatibilities({
				type: "reattach",
				activeSessionId: "active-1",
				targetActiveSessionId: "active-2",
				telemetryDisabled: true,
			}),
		).toEqual([{ minProtocol: 7, minSchemaRevision: 14 }, { minProtocol: 7 }]);
	});

	it("version- and capability-gates prompt admission cancellation", () => {
		expect(DAEMON_COMMAND_COMPATIBILITY.cancel_prompt_admission).toEqual({
			minProtocol: 7,
			minSchemaRevision: 8,
			capability: "prompt_admission_cancellation",
		});
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("prompt_admission_cancellation");
	});

	it("gates honest worker-state reporting at its introducing schema revision", () => {
		// Revision 16 adds the "stopping" workerState and stops reporting
		// disconnected workers as "ready". The field is optional and old clients
		// ignore unknown values, so no capability gate is needed; the revision
		// lets version probes distinguish daemons with the old semantics.
		expect(DAEMON_SCHEMA_REVISION).toBeGreaterThanOrEqual(16);
	it("capability-gates queued action identity and cancellation", () => {
		expect(QUEUED_ACTION_CANCELLATION_COMMAND_TYPES).toEqual(["get_queued_user_actions", "cancel_queued_action"]);
		for (const command of QUEUED_ACTION_CANCELLATION_COMMAND_TYPES) {
			expect(DAEMON_COMMAND_COMPATIBILITY[command]).toEqual({
				minProtocol: 7,
				minSchemaRevision: 15,
				capability: "queued_action_cancellation",
			});
		}
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("queued_action_cancellation");
		// A new daemon keeps the old queue snapshot command available to clients
		// that do not negotiate the optional identity surface.
		expect(DAEMON_COMMAND_COMPATIBILITY.get_queue).toEqual({ minProtocol: 7 });

	});

	it("keeps refine failure events backward-compatible on the existing session event channel", () => {
		const event: DaemonOutbound = {
			type: "session_event",
			activeSessionId: "active-1",
			event: { type: "refine_failed", error: "disk full" },
		};

		// Refine events remain on the original session-event channel across later schema revisions.
		expect(DAEMON_SCHEMA_REVISION).toBeGreaterThanOrEqual(6);
		expect(DAEMON_OUTBOUND_COMPATIBILITY.session_event).toEqual({ minProtocol: 7 });
		expect(event).toMatchObject({ event: { type: "refine_failed", error: "disk full" } });
	});

	it("accepts legacy side-question and bash shapes in new daemons and clients", () => {
		const oldClientSideQuestion: DaemonCommand = {
			type: "start_side_question",
			activeSessionId: "active-1",
			sideQuestionId: "side-1",
			question: "What changed?",
		};
		const oldClientBash: DaemonCommand = {
			type: "execute_bash",
			activeSessionId: "active-1",
			command: "ls",
		};
		const oldDaemonBashStart: DaemonOutbound = {
			type: "session_event",
			activeSessionId: "active-1",
			event: { type: "bash_start", command: "ls", excludeFromContext: false },
		};
		const oldDaemonBashEnd: DaemonOutbound = {
			type: "session_event",
			activeSessionId: "active-1",
			event: { type: "bash_end", exitCode: 0, cancelled: false, truncated: false },
		};

		expect(DAEMON_COMMAND_COMPATIBILITY.start_side_question).toEqual({ minProtocol: 7 });
		expect(DAEMON_COMMAND_COMPATIBILITY.execute_bash).toEqual({ minProtocol: 7 });
		expect(DAEMON_OUTBOUND_COMPATIBILITY.session_event).toEqual({ minProtocol: 7 });
		expect(oldClientSideQuestion).not.toHaveProperty("previousTurns");
		expect(oldClientBash).not.toHaveProperty("transient");
		expect(oldClientBash).not.toHaveProperty("runId");
		expect(oldDaemonBashStart.event).not.toHaveProperty("transient");
		expect(oldDaemonBashStart.event).not.toHaveProperty("runId");
		expect(oldDaemonBashEnd.event).not.toHaveProperty("transient");
		expect(oldDaemonBashEnd.event).not.toHaveProperty("runId");
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toEqual(
			expect.arrayContaining(["side_question_transcript", "transient_bash"]),
		);
	});

	it("creates versioned command and event envelopes", () => {
		const command = { id: "cmd-1", type: "attach", activeSessionId: "active-1" } as const;
		const commandEnvelope = createDaemonCommandEnvelope(command, "cmd-1", "client-1");
		const eventMeta = createDaemonEventMeta("active-1", 3, "2026-01-01T00:00:00.000Z");
		const event: DaemonOutbound = {
			type: "session_event",
			activeSessionId: "active-1",
			event: { type: "agent_end", messages: [] },
			meta: eventMeta,
		};

		expect(commandEnvelope).toEqual({
			type: "command",
			id: "cmd-1",
			protocol: DAEMON_PROTOCOL_INFO,
			clientId: "client-1",
			command,
		});
		expect(createDaemonEventEnvelope(event, eventMeta)).toEqual({
			type: "event",
			id: "active-1:3",
			protocol: DAEMON_PROTOCOL_INFO,
			activeSessionId: "active-1",
			sequence: 3,
			cursor: { generation: "active-1", sequence: 3 },
			emittedAt: "2026-01-01T00:00:00.000Z",
			event,
		});
		expect(eventMeta.cursor).toEqual({ generation: "active-1", sequence: 3 });
	});

	it("rejects command envelopes from pre-session-action protocols", () => {
		const command = { id: "cmd-1", type: "attach", activeSessionId: "active-1" } as const;

		expect(isDaemonCommandEnvelope(createDaemonCommandEnvelope(command, "cmd-1", "client-1", 7))).toBe(true);
		expect(isDaemonCommandEnvelope(createDaemonCommandEnvelope(command, "cmd-1", "client-1", 6))).toBe(false);
	});

	it("keeps attachment routing out of the durable mutation journal", () => {
		expect(isDaemonMutatingCommand({ type: "attach" })).toBe(false);
		expect(isDaemonMutatingCommand({ type: "reattach" })).toBe(false);
		expect(isDaemonMutatingCommand({ type: "wait_for_headless_completion" })).toBe(true);
		expect(isDaemonMutatingCommand({ type: "switch_session" })).toBe(true);
	});

	it("reports replay availability from resume cursors", () => {
		expect(createDaemonReplayInfo(undefined, 5, "generation-1")).toEqual({
			status: "complete",
			toSequence: 5,
			toCursor: { generation: "generation-1", sequence: 5 },
		});
		expect(
			createDaemonReplayInfo(
				{ activeSessionId: "active-1", generation: "generation-1", sequence: 5 },
				5,
				"generation-1",
			),
		).toEqual({
			status: "complete",
			fromSequence: 5,
			toSequence: 5,
			fromCursor: { generation: "generation-1", sequence: 5 },
			toCursor: { generation: "generation-1", sequence: 5 },
		});
		expect(createDaemonReplayInfo({ generation: "generation-1", sequence: 10 }, 5, "generation-1")).toEqual({
			status: "unavailable",
			fromSequence: 10,
			toSequence: 5,
			fromCursor: { generation: "generation-1", sequence: 10 },
			toCursor: { generation: "generation-1", sequence: 5 },
			reason: "resume_cursor_ahead_of_session",
		});
		expect(createDaemonReplayInfo({ generation: "generation-1", sequence: 2 }, 5, "generation-1")).toEqual({
			status: "unavailable",
			fromSequence: 2,
			toSequence: 5,
			fromCursor: { generation: "generation-1", sequence: 2 },
			toCursor: { generation: "generation-1", sequence: 5 },
			reason: "event_replay_not_available",
		});
		expect(createDaemonReplayInfo({ generation: "old", sequence: 5 }, 0, "new")).toMatchObject({
			status: "unavailable",
			reason: "event_generation_changed",
			fromCursor: { generation: "old", sequence: 5 },
			toCursor: { generation: "new", sequence: 0 },
		});
	});

	it("salvages command ids from rejected lines regardless of shape validity", () => {
		const oldEnvelope = JSON.stringify(
			createDaemonCommandEnvelope({ type: "list" } as DaemonCommand, "list-1", "old-client", 6),
		);
		expect(salvageDaemonCommandId(oldEnvelope)).toBe("list-1");
		expect(salvageDaemonCommandId(JSON.stringify({ type: "list", id: "bare-1" }))).toBe("bare-1");
		expect(salvageDaemonCommandId(JSON.stringify({ type: null, id: "typeless-1" }))).toBe("typeless-1");
		expect(salvageDaemonCommandId(JSON.stringify({ id: "no-type" }))).toBe("no-type");
		expect(salvageDaemonCommandId(JSON.stringify({ type: "command", id: 7 }))).toBeUndefined();
		expect(salvageDaemonCommandId(JSON.stringify("command"))).toBeUndefined();
		expect(salvageDaemonCommandId("{ not json")).toBeUndefined();
	});
});
