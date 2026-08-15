/**
 * Rootless Linux PID-namespace containment for a complete kernel generation.
 * A tiny init is PID 1 and reaps children; its exit kills setsid/double-fork descendants.
 * `unshare --kill-child` also kills PID 1 if the outer monitor dies.
 */
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { Readable } from "node:stream";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import {
	type ActiveOrphanProcess,
	ORPHAN_PROCESS_JOURNAL_ENV,
	registerOrphanProcessDurably,
	unregisterOrphanProcessDurably,
} from "../orphan-process-journal.js";

const UNSHARE_ARGS = ["--user", "--map-current-user", "--pid", "--fork", "--kill-child=SIGKILL", "--"] as const;
const HANDSHAKE_TIMEOUT_MS = 3000;
const REAP_TIMEOUT_MS = 5000;
const CONTAINED_KERNEL_ENV = "PRIME_AGENT_INTERNAL_CONTAINED_KERNEL_ENV";
const NAMESPACE_INIT = `
import json, os, signal, subprocess, sys
if os.getpid() != 1:
    sys.exit(125)
kernel_env = json.loads(os.environ.pop("PRIME_AGENT_INTERNAL_CONTAINED_KERNEL_ENV"))
kernel = subprocess.Popen(sys.argv[1:], env=kernel_env)

def forward(signum, _frame):
    if kernel.poll() is None:
        try: kernel.send_signal(signum)
        except ProcessLookupError: pass

signal.signal(signal.SIGTERM, forward)
signal.signal(signal.SIGINT, forward)
host_init_pid = int(open("/proc/self/stat").read().split()[0])
os.write(3, ("ready:%d\\n" % host_init_pid).encode())
os.close(3)
kernel_status = None
while True:
    try:
        pid, status = os.waitpid(-1, 0)
    except ChildProcessError:
        break
    if pid == kernel.pid:
        kernel_status = status
        try: os.kill(-1, signal.SIGKILL)
        except ProcessLookupError: pass
if kernel_status is None:
    sys.exit(1)
sys.exit(os.waitstatus_to_exitcode(kernel_status))
`;

export interface ContainedProcessReceipt {
	generationId: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
}

export class ContainmentUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ContainmentUnavailableError";
	}
}

export type ContainmentSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
export type ContainmentLauncher = (
	command: string,
	args: string[],
	options: SpawnOptions,
	sessionId?: string,
	launchOptions?: ContainmentLaunchOptions,
) => Promise<PidNamespaceOperation>;

export interface ContainmentLaunchOptions {
	spawn?: ContainmentSpawn;
	handshakeTimeoutMs?: number;
	reapTimeoutMs?: number;
	initCommand?: string;
}

function executableRealpath(path: string): string | undefined {
	try {
		accessSync(path, constants.X_OK);
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

function trustedSystemExecutable(name: "unshare" | "python3"): string {
	for (const directory of ["/usr/bin", "/bin"]) {
		const resolved = executableRealpath(join(directory, name));
		if (resolved) return resolved;
	}
	throw new ContainmentUnavailableError(`Trusted system ${name} executable is unavailable`);
}

function trustedInitExecutable(command: string | undefined): string {
	if (!command) return trustedSystemExecutable("python3");
	if (isAbsolute(command)) {
		const resolved = executableRealpath(command);
		if (resolved) return resolved;
		throw new ContainmentUnavailableError("Configured namespace init executable is unavailable");
	}
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory || !isAbsolute(directory)) continue;
		const resolved = executableRealpath(join(directory, command));
		if (resolved) return resolved;
	}
	throw new ContainmentUnavailableError("Configured namespace init executable is not on the trusted host PATH");
}

interface RegisteredOperation {
	sessionId?: string;
	operation: PidNamespaceOperation;
}

const operations = new Set<RegisteredOperation>();
let cleanupRegistered = false;

function registerCleanupOnce(): void {
	if (cleanupRegistered) return;
	cleanupRegistered = true;
	registerSessionResourceCleanup((sessionId) => {
		// The pi-ai cleanup API is synchronous. This hook is explicitly best effort;
		// KernelManager.kill() is the verified, awaited path.
		for (const entry of operations) {
			if (!sessionId || entry.sessionId === sessionId) entry.operation.killBestEffort();
		}
	});
	process.once("exit", () => {
		for (const entry of operations) entry.operation.killSync();
	});
}

function monitorReceipt(child: ChildProcess, generationId: string): Promise<ContainedProcessReceipt> {
	return new Promise((resolve, reject) => {
		let exit: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;
		let stdoutClosed = child.stdout === null || child.stdout.readableEnded || child.stdout.destroyed;
		let stderrClosed = child.stderr === null || child.stderr.readableEnded || child.stderr.destroyed;
		let settled = false;
		const cleanup = () => {
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.stdout?.removeListener("end", onStdoutClose);
			child.stdout?.removeListener("close", onStdoutClose);
			child.stderr?.removeListener("end", onStderrClose);
			child.stderr?.removeListener("close", onStderrClose);
		};
		const finish = (error?: Error) => {
			if (settled) return;
			if (!error && (!exit || !stdoutClosed || !stderrClosed)) return;
			settled = true;
			cleanup();
			if (error) reject(error);
			else resolve({ generationId, ...exit! });
		};
		const onError = (error: Error) => finish(error);
		const onExit = (exitCode: number | null, signal: NodeJS.Signals | null) => {
			exit = { exitCode, signal };
			finish();
		};
		const onStdoutClose = () => {
			stdoutClosed = true;
			finish();
		};
		const onStderrClose = () => {
			stderrClosed = true;
			finish();
		};
		child.once("error", onError);
		child.once("exit", onExit);
		child.stdout?.once("end", onStdoutClose);
		child.stdout?.once("close", onStdoutClose);
		child.stderr?.once("end", onStderrClose);
		child.stderr?.once("close", onStderrClose);
		if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
	});
}

async function waitBounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
				timer.unref();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function waitForHandshake(child: ChildProcess, timeoutMs: number): Promise<number> {
	const handshake = child.stdio[3] as Readable | null;
	if (!handshake) return Promise.reject(new ContainmentUnavailableError("containment handshake pipe unavailable"));
	return new Promise((resolve, reject) => {
		let buffer = "";
		let settled = false;
		const cleanup = () => {
			clearTimeout(timer);
			handshake.removeListener("data", onData);
			handshake.removeListener("end", onEnd);
			child.removeListener("error", onError);
		};
		const finish = (error?: Error, initPid?: number) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) reject(error);
			else resolve(initPid!);
		};
		const onData = (chunk: Buffer) => {
			buffer += chunk.toString();
			const match = /ready:(\d+)\n/.exec(buffer);
			if (match) finish(undefined, Number(match[1]));
		};
		const onEnd = () => finish(new ContainmentUnavailableError("inner PID 1 exited before launch handshake"));
		const onError = (error: Error) =>
			finish(new ContainmentUnavailableError(`unshare launch failed: ${error.message}`));
		const timer = setTimeout(
			() => finish(new ContainmentUnavailableError(`containment launch handshake timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
		timer.unref();
		handshake.on("data", onData);
		handshake.once("end", onEnd);
		child.once("error", onError);
	});
}

export class PidNamespaceOperation {
	readonly generationId: string;
	readonly monitor: ChildProcess;
	private generationSealed = false;
	private readonly receiptPromise: Promise<ContainedProcessReceipt>;
	private readonly reapTimeoutMs: number;
	private readonly orphanIdentities: ActiveOrphanProcess[];
	private stderrBuffer = "";
	private readonly identitiesSealed: Promise<void>;
	private resolveIdentitiesSealed!: () => void;
	private identityRegistrationSealed = false;
	private registryEntry?: RegisteredOperation;

	constructor(generationId: string, monitor: ChildProcess, sessionId: string | undefined, reapTimeoutMs: number) {
		this.generationId = generationId;
		this.monitor = monitor;
		this.reapTimeoutMs = reapTimeoutMs;
		if (!monitor.pid) throw new Error("Containment monitor has no pid");
		this.orphanIdentities = [registerOrphanProcessDurably(monitor.pid)];
		this.identitiesSealed = new Promise<void>((resolve) => {
			this.resolveIdentitiesSealed = resolve;
		});
		registerCleanupOnce();
		this.registryEntry = { sessionId, operation: this };
		operations.add(this.registryEntry);
		monitor.stderr?.on("data", (chunk: Buffer) => {
			this.stderrBuffer = `${this.stderrBuffer}${chunk.toString()}`.slice(-8192);
		});
		// Kernel stdout is not user output and must be drained or a noisy kernel can
		// fill the pipe and prevent monitor reaping. KernelManager drains stderr.
		monitor.stdout?.resume();
		this.receiptPromise = monitorReceipt(monitor, generationId).finally(async () => {
			await this.identitiesSealed;
			const errors: unknown[] = [];
			try {
				for (const identity of this.orphanIdentities) {
					try {
						unregisterOrphanProcessDurably(identity);
					} catch (error) {
						errors.push(error);
					}
				}
			} finally {
				if (this.registryEntry) operations.delete(this.registryEntry);
				this.registryEntry = undefined;
			}
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "Failed to durably unregister contained processes");
		});
	}

	registerNamespaceInit(pid: number): void {
		this.orphanIdentities.push(registerOrphanProcessDurably(pid));
	}

	sealIdentityRegistration(): void {
		if (this.identityRegistrationSealed) return;
		this.identityRegistrationSealed = true;
		this.resolveIdentitiesSealed();
	}

	get stderrTail(): string {
		return this.stderrBuffer;
	}

	get isGenerationSealed(): boolean {
		return this.generationSealed;
	}

	sealGeneration(): void {
		this.generationSealed = true;
	}

	async killAndWaitVerified(): Promise<ContainedProcessReceipt> {
		this.sealGeneration();
		if (this.monitor.exitCode === null && this.monitor.signalCode === null) this.monitor.kill("SIGKILL");
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				this.receiptPromise,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() =>
							reject(
								new Error(
									`Contained generation ${this.generationId} did not reap and close transports within ${this.reapTimeoutMs}ms`,
								),
							),
						this.reapTimeoutMs,
					);
					timer.unref();
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	killBestEffort(): void {
		this.sealGeneration();
		if (this.monitor.exitCode === null && this.monitor.signalCode === null) this.monitor.kill("SIGKILL");
		void this.receiptPromise.catch(() => {});
	}

	waitForReapAndTransportClose(): Promise<ContainedProcessReceipt> {
		return this.receiptPromise;
	}

	killSync(): void {
		this.sealGeneration();
		if (this.monitor.exitCode === null && this.monitor.signalCode === null) this.monitor.kill("SIGKILL");
	}
}

/**
 * Launch and return only after the inner PID 1 has acknowledged admission.
 * Failure before that handshake is unsupported containment and may be handled by
 * an ordinary unmanaged caller. Once returned, the generation never falls back.
 */
export async function launchPidNamespaceOperation(
	command: string,
	args: string[],
	options: SpawnOptions,
	sessionId?: string,
	launchOptions: ContainmentLaunchOptions = {},
): Promise<PidNamespaceOperation> {
	const generationId = randomUUID();
	if (process.platform !== "linux") throw new ContainmentUnavailableError("PID namespace containment requires Linux");
	if (!process.env[ORPHAN_PROCESS_JOURNAL_ENV]) {
		throw new ContainmentUnavailableError("Durable containment journal is not configured for this session");
	}
	const spawnProcess: ContainmentSpawn = launchOptions.spawn ?? spawn;
	const unshare = trustedSystemExecutable("unshare");
	const init = trustedInitExecutable(launchOptions.initCommand);
	const targetEnvironment = options.env ?? process.env;
	const initEnvironment = {
		...process.env,
		[CONTAINED_KERNEL_ENV]: JSON.stringify(targetEnvironment),
	};
	const monitor = spawnProcess(unshare, [...UNSHARE_ARGS, init, "-c", NAMESPACE_INIT, command, ...args], {
		...options,
		env: initEnvironment,
		stdio: ["ignore", "pipe", "pipe", "pipe"],
	});
	const reapTimeoutMs = launchOptions.reapTimeoutMs ?? REAP_TIMEOUT_MS;
	if (!monitor.pid) {
		try {
			await waitForHandshake(monitor, launchOptions.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
		} catch (error) {
			throw error instanceof ContainmentUnavailableError
				? error
				: new ContainmentUnavailableError(error instanceof Error ? error.message : String(error));
		}
		throw new Error("Containment monitor reported ready without a pid");
	}
	let operation: PidNamespaceOperation;
	try {
		operation = new PidNamespaceOperation(generationId, monitor, sessionId, reapTimeoutMs);
	} catch (error) {
		monitor.stdout?.resume();
		monitor.stderr?.resume();
		monitor.kill("SIGKILL");
		await waitBounded(
			monitorReceipt(monitor, generationId),
			reapTimeoutMs,
			`Unregistered containment monitor ${generationId} did not reap`,
		);
		throw new Error(
			`Durable containment monitor registration failed: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	try {
		const initPid = await waitForHandshake(monitor, launchOptions.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
		operation.registerNamespaceInit(initPid);
		operation.sealIdentityRegistration();
		return operation;
	} catch (error) {
		operation.sealIdentityRegistration();
		try {
			await operation.killAndWaitVerified();
		} catch (cleanupError) {
			throw new Error(
				`Containment launch cleanup was not verified: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
				{ cause: error },
			);
		}
		const diagnostic = operation.stderrTail.trim();
		const message = `${error instanceof Error ? error.message : String(error)}${diagnostic ? `\n${diagnostic}` : ""}`;
		throw error instanceof ContainmentUnavailableError
			? new ContainmentUnavailableError(message)
			: new Error(message);
	}
}

/** Probe through the same handshake used by real launches; no result is cached. */
export async function probePidNamespaceContainment(): Promise<boolean> {
	try {
		const operation = await launchPidNamespaceOperation("/bin/sleep", ["60"], { stdio: ["ignore", "pipe", "pipe"] });
		await operation.killAndWaitVerified();
		return true;
	} catch {
		return false;
	}
}
