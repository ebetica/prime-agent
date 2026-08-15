import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as forkServer from "../src/core/kernel/fork-server.js";
import { KernelManager } from "../src/core/kernel/index.js";
import {
	type ContainmentLauncher,
	ContainmentUnavailableError,
	PidNamespaceOperation,
	probePidNamespaceContainment,
} from "../src/core/kernel/process-containment.js";
import { ORPHAN_PROCESS_JOURNAL_ENV } from "../src/core/orphan-process-journal.js";
import { processIdExists } from "../src/utils/child-process.js";

vi.mock("../src/core/kernel/fork-server.js", async (importOriginal) => {
	const actual = await importOriginal<typeof forkServer>();
	return { ...actual, forkKernel: vi.fn(actual.forkKernel) };
});

let tempDir = "";

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
}

describe("KernelManager startup", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-startup-"));
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = join(tempDir, "orphans.jsonl");
	});

	afterEach(() => {
		delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("surfaces kernels that exit before resolving ports", async () => {
		const python = join(tempDir, "python");
		writeExecutable(python, ["#!/bin/sh", 'echo "fake kernel died before binding" >&2', "exit 42", ""].join("\n"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const containmentLauncher = vi.fn(async () => {
			throw new ContainmentUnavailableError("unsupported in test");
		});
		const manager = new KernelManager({ python, cwd: tempDir, containmentLauncher });

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(
				/Kernel exited before resolving ports[\s\S]*fake kernel died before binding/,
			);
			expect(containmentLauncher).toHaveBeenCalledOnce();
		} finally {
			errorSpy.mockRestore();
			await manager.dispose();
		}
	});

	it("boots an ordinary unmanaged kernel when containment is unavailable", async () => {
		const previous = process.env.PRIME_AGENT_KERNEL_FORKSERVER;
		process.env.PRIME_AGENT_KERNEL_FORKSERVER = "0";
		const containmentLauncher: ContainmentLauncher = async () => {
			throw new ContainmentUnavailableError("unsupported in test");
		};
		const manager = new KernelManager({ python: "python3", cwd: tempDir, containmentLauncher });
		try {
			const result = await manager.execute("print('ordinary')");
			expect(result.stdout.trim()).toBe("ordinary");
			expect(manager.containedGenerationId).toBeUndefined();
		} finally {
			await manager.kill();
			if (previous === undefined) delete process.env.PRIME_AGENT_KERNEL_FORKSERVER;
			else process.env.PRIME_AGENT_KERNEL_FORKSERVER = previous;
		}
	}, 10_000);

	it("scrubs host controls from direct model kernels", async () => {
		const previousFork = process.env.PRIME_AGENT_KERNEL_FORKSERVER;
		const journal = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		const inherited = process.env.PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET;
		process.env.PRIME_AGENT_KERNEL_FORKSERVER = "0";
		process.env.PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET = "inherited-socket";
		delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		const manager = new KernelManager({
			python: "python3",
			cwd: tempDir,
			env: {
				PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN: "override-token",
				PRIME_AGENT_INTERNAL_OWNED_RECOVERY_DESCRIPTOR: "owned-descriptor",
			},
		});
		try {
			const result = await manager.execute(
				'import os; print(os.environ.get("PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET"), os.environ.get("PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN"), os.environ.get("PRIME_AGENT_INTERNAL_OWNED_RECOVERY_DESCRIPTOR"))',
			);
			expect(result.stdout.trim()).toBe("None None None");
		} finally {
			await manager.kill();
			if (journal === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
			else process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journal;
			if (inherited === undefined) delete process.env.PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET;
			else process.env.PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET = inherited;
			if (previousFork === undefined) delete process.env.PRIME_AGENT_KERNEL_FORKSERVER;
			else process.env.PRIME_AGENT_KERNEL_FORKSERVER = previousFork;
		}
	}, 20_000);

	it("scrubs host controls from forkserver templates and children", async () => {
		const previousFork = process.env.PRIME_AGENT_KERNEL_FORKSERVER;
		const journal = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		const inherited = process.env.PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN;
		process.env.PRIME_AGENT_KERNEL_FORKSERVER = "1";
		process.env.PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN = "inherited-token";
		delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		vi.mocked(forkServer.forkKernel).mockClear();
		const manager = new KernelManager({
			python: "python3",
			cwd: tempDir,
			env: {
				PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET: "override-socket",
				PRIME_AGENT_INTERNAL_OWNED_PROFILE: "owned-profile",
			},
		});
		try {
			const result = await manager.execute(
				'import os; print(os.environ.get("PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN"), os.environ.get("PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET"), os.environ.get("PRIME_AGENT_INTERNAL_OWNED_PROFILE"))',
			);
			expect(result.stdout.trim()).toBe("None None None");
			expect(forkServer.forkKernel).toHaveBeenCalledOnce();
		} finally {
			await manager.kill();
			if (journal === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
			else process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journal;
			if (inherited === undefined) delete process.env.PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN;
			else process.env.PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN = inherited;
			if (previousFork === undefined) delete process.env.PRIME_AGENT_KERNEL_FORKSERVER;
			else process.env.PRIME_AGENT_KERNEL_FORKSERVER = previousFork;
		}
	}, 20_000);

	it("fails closed when a required host is missing its containment journal", async () => {
		const previousFork = process.env.PRIME_AGENT_KERNEL_FORKSERVER;
		const journal = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		process.env.PRIME_AGENT_KERNEL_FORKSERVER = "1";
		delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		vi.mocked(forkServer.forkKernel).mockClear();
		try {
			const manager = new KernelManager({
				python: "python3",
				cwd: tempDir,
				kernelContainment: "required",
			});
			await expect(manager.execute("print('must not launch')")).rejects.toThrow(
				"Durable containment journal is not configured",
			);
			expect(manager.containedGenerationId).toBeUndefined();
			expect(forkServer.forkKernel).not.toHaveBeenCalled();
		} finally {
			if (journal === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
			else process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journal;
			if (previousFork === undefined) delete process.env.PRIME_AGENT_KERNEL_FORKSERVER;
			else process.env.PRIME_AGENT_KERNEL_FORKSERVER = previousFork;
		}
	}, 10_000);

	it("keeps unmanaged IPython available without containment capability but fails closed on storage faults", async () => {
		const previousFork = process.env.PRIME_AGENT_KERNEL_FORKSERVER;
		const configuredJournal = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		process.env.PRIME_AGENT_KERNEL_FORKSERVER = "0";
		try {
			delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
			const unmanaged = new KernelManager({ python: "python3", cwd: tempDir });
			try {
				const result = await unmanaged.execute("print('ordinary')");
				expect(result.stdout.trim()).toBe("ordinary");
				expect(unmanaged.containedGenerationId).toBeUndefined();
			} finally {
				await unmanaged.kill();
			}

			process.env[ORPHAN_PROCESS_JOURNAL_ENV] = join(tempDir, "missing-directory", "orphans.jsonl");
			const storageFault = new KernelManager({ python: "python3", cwd: tempDir });
			await expect(storageFault.execute("print('must not launch')")).rejects.toThrow(
				"Durable containment monitor registration failed",
			);
			expect(storageFault.containedGenerationId).toBeUndefined();
		} finally {
			if (configuredJournal === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
			else process.env[ORPHAN_PROCESS_JOURNAL_ENV] = configuredJournal;
			if (previousFork === undefined) delete process.env.PRIME_AGENT_KERNEL_FORKSERVER;
			else process.env.PRIME_AGENT_KERNEL_FORKSERVER = previousFork;
		}
	}, 20_000);

	it("never calls forkKernel for a successful contained launch when forkserver is enabled", async () => {
		vi.mocked(forkServer.forkKernel).mockClear();
		const launcher: ContainmentLauncher = vi.fn(async (command, args, options, sessionId) => {
			const monitor = spawn(command, args, options);
			const operation = new PidNamespaceOperation(randomUUID(), monitor, sessionId, 10_000);
			operation.sealIdentityRegistration();
			return operation;
		});
		const manager = new KernelManager({ python: "python3", cwd: tempDir, containmentLauncher: launcher });
		try {
			const first = await manager.execute("print('first')");
			expect(first.stdout).toContain("first");
			const firstGeneration = manager.containedGenerationId;
			expect(firstGeneration).toBeTypeOf("string");
			await manager.restart();
			const second = await manager.execute("print('second')");
			expect(second.stdout).toContain("second");
			expect(manager.containedGenerationId).not.toBe(firstGeneration);
			expect(launcher).toHaveBeenCalledTimes(2);
			expect(forkServer.forkKernel).not.toHaveBeenCalled();
		} finally {
			await manager.kill();
		}
	}, 20_000);

	it("retains a contained operation after verified reap rejects", async () => {
		const manager = new KernelManager({ cwd: tempDir });
		const failure = new Error("receipt timeout");
		const killAndWaitVerified = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({
			generationId: "generation",
			exitCode: null,
			signal: "SIGKILL",
		});
		const operation = { killAndWaitVerified } as unknown as PidNamespaceOperation;
		Object.assign(manager, { kernelOperation: operation });

		await expect(manager.kill()).rejects.toBe(failure);
		expect((manager as unknown as { kernelOperation?: PidNamespaceOperation }).kernelOperation).toBe(operation);
		await expect(manager.kill()).resolves.toBeUndefined();
		expect(killAndWaitVerified).toHaveBeenCalledTimes(2);
		expect((manager as unknown as { kernelOperation?: PidNamespaceOperation }).kernelOperation).toBeUndefined();
	});

	it("does not start a replacement when verified shutdown rejects", async () => {
		const manager = new KernelManager({ cwd: tempDir });
		const shutdown = vi.fn(async () => {
			throw new Error("receipt timeout");
		});
		const start = vi.fn(async () => {});
		Object.assign(manager, { shutdown, start });

		await expect(manager.restart()).rejects.toThrow("receipt timeout");
		expect(start).not.toHaveBeenCalled();
	});

	it("restarts a real contained kernel without leaving cell descendants or state", async () => {
		if (!(await probePidNamespaceContainment())) return;
		const pidPath = join(tempDir, "cell-daemon.pid");
		const latePath = join(tempDir, "cell-late");
		const sentinel = spawn("/bin/sleep", ["10"]);
		const daemonCode = `
import os, signal, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
if os.fork(): os._exit(0)
if os.fork(): os._exit(0)
open(${JSON.stringify(pidPath)}, "w").write(open("/proc/self/stat").read().split()[0])
time.sleep(1)
open(${JSON.stringify(latePath)}, "w").write("late")
time.sleep(60)
`;
		const manager = new KernelManager({ python: "python3", cwd: tempDir });
		try {
			const result = await manager.execute(`
import subprocess, sys
cell_marker = "old-generation"
subprocess.Popen([sys.executable, "-c", ${JSON.stringify(daemonCode)}], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
`);
			expect(result.status).toBe("ok");
			for (let attempt = 0; attempt < 200 && !existsSync(pidPath); attempt++)
				await new Promise((r) => setTimeout(r, 20));
			const daemonPid = Number(readFileSync(pidPath, "utf8"));
			const firstGeneration = manager.containedGenerationId;
			await manager.restart();
			expect(manager.containedGenerationId).not.toBe(firstGeneration);
			const state = await manager.execute('print("cell_marker" in globals())');
			expect(state.stdout.trim()).toBe("False");
			expect(processIdExists(daemonPid)).toBe(false);
			expect(sentinel.pid && processIdExists(sentinel.pid)).toBe(true);
			await new Promise((r) => setTimeout(r, 1200));
			expect(existsSync(latePath)).toBe(false);
		} finally {
			sentinel.kill("SIGKILL");
			await manager.kill();
		}
	}, 20_000);
});
