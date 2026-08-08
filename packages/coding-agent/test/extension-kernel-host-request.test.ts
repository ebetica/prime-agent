import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory, KernelHostRequestContext } from "../src/core/extensions/index.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

type HostHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

function kernelHostHandlers(session: unknown): Record<string, HostHandler> {
	return (
		session as {
			_createKernelHostHandlers(): Record<string, HostHandler>;
		}
	)._createKernelHostHandlers();
}

describe("extension kernel host requests", () => {
	const cleanupPaths: string[] = [];

	afterEach(() => {
		while (cleanupPaths.length > 0) {
			const path = cleanupPaths.pop();
			if (path && existsSync(path)) rmSync(path, { recursive: true, force: true });
		}
	});

	async function createSession(extensionFactory: ExtensionFactory, sessionManager?: SessionManager) {
		const tempDir = join(tmpdir(), `pi-host-request-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const manager = sessionManager ?? SessionManager.create(tempDir, join(tempDir, "sessions"));
		if (manager.isPersisted() && !manager.getSessionFile()) manager.materializeSessionFile();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [extensionFactory],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: manager,
			resourceLoader,
		});
		return { session, sessionManager: manager, tempDir };
	}

	it("binds ownerless payloads to the current durable transcript", async () => {
		let receivedContext: KernelHostRequestContext | undefined;
		const configuredRoot = "/host-owned/artifacts";
		const { session, sessionManager } = await createSession((pi) => {
			pi.registerKernelHostRequest("recurse.artifact_create", {
				allowedPayloadKeys: ["title", "format", "kind"],
				handler: async (payload, context) => {
					receivedContext = context;
					return { title: payload.title, configuredRoot };
				},
			});
		});
		try {
			const result = await kernelHostHandlers(session)["recurse.artifact_create"]({
				type: "recurse.artifact_create",
				title: "Report",
				format: "markdown",
				kind: "document",
				cellSourceCode: "await artifact.create('Report')",
			});
			expect(result).toEqual({ title: "Report", configuredRoot });
			expect(receivedContext?.sessionFile).toBe(resolve(sessionManager.getSessionFile()!));
			expect(receivedContext?.sessionId).toBe(sessionManager.getSessionId());
			expect(receivedContext?.signal.aborted).toBe(false);
		} finally {
			session.dispose();
		}
	});

	it.each(["owner", "root", "artifactRoot", "sessionFile", "path", "daemonToken"])(
		"rejects forged %s fields before the registered handler",
		async (forgedKey) => {
			let called = false;
			const { session } = await createSession((pi) => {
				pi.registerKernelHostRequest("recurse.artifact_create", {
					allowedPayloadKeys: ["title", "format", "kind"],
					handler: async () => {
						called = true;
						return {};
					},
				});
			});
			try {
				await expect(
					kernelHostHandlers(session)["recurse.artifact_create"]({
						title: "Report",
						[forgedKey]: "../someone-else",
					}),
				).rejects.toThrow(`does not accept payload key "${forgedKey}"`);
				expect(called).toBe(false);
			} finally {
				session.dispose();
			}
		},
	);

	it("is unavailable without registration or durable session identity", async () => {
		const unregistered = await createSession(() => {});
		try {
			expect(kernelHostHandlers(unregistered.session)).not.toHaveProperty("recurse.artifact_list");
		} finally {
			unregistered.session.dispose();
		}

		let called = false;
		const memoryManager = SessionManager.inMemory();
		const withoutIdentity = await createSession((pi) => {
			pi.registerKernelHostRequest("recurse.artifact_list", {
				allowedPayloadKeys: [],
				handler: async () => {
					called = true;
					return {};
				},
			});
		}, memoryManager);
		try {
			await expect(kernelHostHandlers(withoutIdentity.session)["recurse.artifact_list"]({})).rejects.toThrow(
				"requires a durable session",
			);
			expect(called).toBe(false);
		} finally {
			withoutIdentity.session.dispose();
		}
	});

	it("keeps reopened sessions on the same transcript and separates distinct sessions", async () => {
		const seen: string[] = [];
		const extension: ExtensionFactory = (pi) => {
			pi.registerKernelHostRequest("recurse.artifact_list", {
				allowedPayloadKeys: [],
				handler: async (_payload, context) => {
					seen.push(context.sessionFile);
					return {};
				},
			});
		};
		const first = await createSession(extension);
		const durableFile = first.sessionManager.getSessionFile()!;
		await kernelHostHandlers(first.session)["recurse.artifact_list"]({});
		first.session.dispose();

		const reopened = await createSession(extension, SessionManager.open(durableFile));
		const distinct = await createSession(extension);
		try {
			await kernelHostHandlers(reopened.session)["recurse.artifact_list"]({});
			await kernelHostHandlers(distinct.session)["recurse.artifact_list"]({});
			expect(seen[1]).toBe(seen[0]);
			expect(seen[2]).not.toBe(seen[0]);
		} finally {
			reopened.session.dispose();
			distinct.session.dispose();
		}
	});

	it("invalidates old capabilities when the extension runtime reloads", async () => {
		const { session, sessionManager } = await createSession((pi) => {
			pi.registerKernelHostRequest("recurse.artifact_list", {
				allowedPayloadKeys: [],
				handler: async (_payload, context) => ({ sessionFile: context.sessionFile }),
			});
		});
		try {
			const oldHandler = kernelHostHandlers(session)["recurse.artifact_list"];
			await session.reload();
			await expect(oldHandler({})).rejects.toThrow("is no longer available");
			await expect(kernelHostHandlers(session)["recurse.artifact_list"]({})).resolves.toEqual({
				sessionFile: resolve(sessionManager.getSessionFile()!),
			});
		} finally {
			session.dispose();
		}
	});

	it("aborts and rejects a request racing session disposal", async () => {
		let handlerStarted: (() => void) | undefined;
		const started = new Promise<void>((resolveStarted) => {
			handlerStarted = resolveStarted;
		});
		const { session } = await createSession((pi) => {
			pi.registerKernelHostRequest("recurse.artifact_create", {
				allowedPayloadKeys: ["title"],
				handler: async (_payload, context) => {
					handlerStarted?.();
					await new Promise<void>((resolveAbort) =>
						context.signal.addEventListener("abort", () => resolveAbort()),
					);
					return {};
				},
			});
		});
		const request = kernelHostHandlers(session)["recurse.artifact_create"]({ title: "Report" });
		await started;
		session.dispose();
		await expect(request).rejects.toThrow("outlived its owning session");
	});
});
