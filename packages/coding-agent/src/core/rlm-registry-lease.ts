/** Process-identity lease for durable registry mutation.
 *
 * A live owner never expires by wall clock. Durable volumes are expected to be
 * mounted by one machine at a time: a different boot of the same machine may
 * reclaim, while a foreign machine/namespace fails closed for explicit lifecycle
 * recovery. Acquisition waits asynchronously and reports the concrete holder.
 */
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { getProcessStartId } from "./session-lease.js";

interface Owner {
	version: 1;
	token: string;
	pid: number;
	processStartId?: string;
	machineId: string;
	bootId: string;
	pidNamespace: string;
	createdAt: string;
}
export interface RegistryLeaseOptions {
	signal?: AbortSignal;
	pollMs?: number;
	onWait?: (message: string) => void;
	identity?: Partial<Pick<Owner, "machineId" | "bootId" | "pidNamespace">>;
	processStartId?: (pid: number) => string | undefined;
}
function system(path: string, fallback: string): string {
	try {
		return readFileSync(path, "utf8").trim() || fallback;
	} catch {
		return fallback;
	}
}
function identity(options: RegistryLeaseOptions): Pick<Owner, "machineId" | "bootId" | "pidNamespace"> {
	return {
		machineId: options.identity?.machineId ?? system("/etc/machine-id", `host:${hostname()}`),
		bootId: options.identity?.bootId ?? system("/proc/sys/kernel/random/boot_id", "unknown-boot"),
		pidNamespace:
			options.identity?.pidNamespace ??
			(() => {
				try {
					return readFileSync("/proc/self/ns/pid", "utf8");
				} catch {
					return "unknown-pidns";
				}
			})(),
	};
}
function fsyncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
function readOwner(path: string): Owner | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as Owner;
		return value.version === 1 && typeof value.token === "string" && typeof value.pid === "number"
			? value
			: undefined;
	} catch {
		return undefined;
	}
}
export function ownerState(
	owner: Owner | undefined,
	current: ReturnType<typeof identity>,
	getStart: (pid: number) => string | undefined,
): "live" | "dead" | "foreign" {
	if (!owner) return "foreign";
	if (owner.machineId !== current.machineId || owner.pidNamespace !== current.pidNamespace) return "foreign";
	if (owner.bootId !== current.bootId) return "dead";
	const observed = getStart(owner.pid);
	if (!observed) return "dead";
	return owner.processStartId === observed ? "live" : "dead";
}
function pause(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason ?? new Error("Registry lease wait aborted"));
		const timer = setTimeout(done, ms);
		function done() {
			signal?.removeEventListener("abort", abort);
			resolve();
		}
		function abort() {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("Registry lease wait aborted"));
		}
		signal?.addEventListener("abort", abort, { once: true });
	});
}
export async function withRegistryLease<T>(
	registryPath: string,
	action: () => T | Promise<T>,
	options: RegistryLeaseOptions = {},
): Promise<T> {
	const directory = dirname(registryPath);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const stable = `${registryPath}.lease`;
	const token = randomUUID();
	const candidate = `${stable}.candidate.${process.pid}.${token}`;
	const current = identity(options);
	const getStart = options.processStartId ?? getProcessStartId;
	const owner: Owner = {
		version: 1,
		token,
		pid: process.pid,
		processStartId: getStart(process.pid),
		...current,
		createdAt: new Date().toISOString(),
	};
	const candidateFd = openSync(candidate, "wx", 0o600);
	try {
		writeFileSync(candidateFd, `${JSON.stringify(owner)}\n`);
		fsyncSync(candidateFd);
	} finally {
		closeSync(candidateFd);
	}
	const started = Date.now();
	let lastLog = 0;
	for (;;) {
		options.signal?.throwIfAborted();
		try {
			linkSync(candidate, stable);
			unlinkSync(candidate);
			fsyncDirectory(directory);
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			const holder = readOwner(stable);
			ownerState(holder, current, getStart);

			const elapsed = Date.now() - started;
			if (elapsed - lastLog >= 1000) {
				lastLog = elapsed;
				options.onWait?.(
					`Waiting ${elapsed}ms for RLM registry lease holder pid=${holder?.pid ?? "unknown"} start=${holder?.processStartId ?? "unknown"} machine=${holder?.machineId ?? "unknown"} boot=${holder?.bootId ?? "unknown"}`,
				);
			}
			await pause(options.pollMs ?? 50, options.signal);
		}
	}
	try {
		return await action();
	} finally {
		const held = readOwner(stable);
		// Normal acquisition never reclaims. The supervisor's globally fenced
		// lifecycle recovery is the only external remover, so a matching token
		// cannot be replaced between this read and unlink.
		if (held?.token === token) {
			try {
				unlinkSync(stable);
				fsyncDirectory(directory);
			} catch {
				// A lifecycle recovery may have removed the exact claim under its global fence.
			}
		}
		try {
			unlinkSync(candidate);
		} catch {
			// Candidate cleanup is best effort; unique names prevent interference.
		}
	}
}
