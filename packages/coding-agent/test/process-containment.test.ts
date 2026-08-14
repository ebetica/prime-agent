import { type SpawnOptions, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ContainmentSpawn,
	ContainmentUnavailableError,
	launchPidNamespaceOperation,
	probePidNamespaceContainment,
} from "../src/core/kernel/process-containment.js";
import {
	clearOrphanProcessJournal,
	isOrphanProcessIdentityCurrent,
	ORPHAN_PROCESS_JOURNAL_ENV,
	readActiveOrphanProcesses,
	terminateActiveOrphanProcesses,
} from "../src/core/orphan-process-journal.js";
import { processIdExists } from "../src/utils/child-process.js";

const tempDirs: string[] = [];

async function waitForFile(path: string): Promise<string> {
	for (let attempt = 0; attempt < 300; attempt++) {
		try {
			const value = readFileSync(path, "utf8").trim();
			if (value) return value;
		} catch {
			// The daemon has not written its pid yet.
		}
		await sleep(20);
	}
	throw new Error(`Timed out waiting for ${path}`);
}

describe("rootless PID namespace containment", () => {
	beforeEach(() => {
		const dir = mkdtempSync(join(tmpdir(), "prime-containment-journal-"));
		tempDirs.push(dir);
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = join(dir, "orphans.jsonl");
	});

	afterEach(() => {
		delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
	});

	it("capability probe verifies a rootless child is PID 1", async () => {
		if (process.platform !== "linux") {
			expect(await probePidNamespaceContainment()).toBe(false);
			return;
		}
		expect(typeof (await probePidNamespaceContainment())).toBe("boolean");
	});

	it("seals monitor and init identities before an immediate exit receipt finalizes", async () => {
		if (!(await probePidNamespaceContainment())) return;
		const operation = await launchPidNamespaceOperation("python3", ["-c", "pass"], {});
		await operation.waitForReapAndTransportClose();
		const journal = process.env[ORPHAN_PROCESS_JOURNAL_ENV]!;
		expect(readActiveOrphanProcesses(journal, process.pid)).toEqual([]);
	});

	it("kills and reaps a setsid double-fork descendant before returning a receipt", async () => {
		if (!(await probePidNamespaceContainment())) return;
		const dir = mkdtempSync(join(tmpdir(), "prime-containment-test-"));
		tempDirs.push(dir);
		const pidPath = join(dir, "daemon.pid");
		const latePath = join(dir, "late-write");
		const zombiePath = join(dir, "zombies");
		const sentinel = spawn("/bin/sleep", ["10"]);
		const daemonCode = `
import os, signal, time
os.setsid()
signal.signal(signal.SIGTERM, signal.SIG_IGN)
if os.fork(): os._exit(0)
if os.fork(): os._exit(0)
open(${JSON.stringify(pidPath)}, "w").write(open("/proc/self/stat").read().split()[0])
time.sleep(1)
open(__LATE_PATH__, "w").write("late")
time.sleep(60)
`.replace("__LATE_PATH__", JSON.stringify(latePath));
		const daemonizer = "import os; pid=os.fork(); os._exit(0) if pid else os._exit(0)";
		const rootCode = `
import glob, subprocess, time, sys
for _ in range(30):
    subprocess.run([sys.executable, "-c", ${JSON.stringify(daemonizer)}], check=True)
time.sleep(0.2)
zombies = 0
for status_path in glob.glob("/proc/[0-9]*/status"):
    try:
        lines = open(status_path).read().splitlines()
        nspid = next(line for line in lines if line.startswith("NSpid:"))
        state = next(line for line in lines if line.startswith("State:"))
        if len(nspid.split()) > 2 and "Z" in state.split()[1]: zombies += 1
    except (OSError, StopIteration): pass
open(${JSON.stringify(zombiePath)}, "w").write(str(zombies))
subprocess.Popen([sys.executable, "-c", ${JSON.stringify(daemonCode)}])
time.sleep(60)
`;
		const operation = await launchPidNamespaceOperation("python3", ["-c", rootCode], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const daemonPid = Number(await waitForFile(pidPath));
		expect(Number(await waitForFile(zombiePath))).toBe(0);
		expect(processIdExists(daemonPid)).toBe(true);

		operation.sealGeneration();
		expect(operation.isGenerationSealed).toBe(true);
		const receipt = await operation.killAndWaitVerified();

		expect(receipt.generationId).toBe(operation.generationId);
		expect(receipt.exitCode === null || receipt.exitCode !== 0).toBe(true);
		expect(processIdExists(daemonPid)).toBe(false);
		expect(sentinel.pid && processIdExists(sentinel.pid)).toBe(true);
		await sleep(1200);
		expect(existsSync(latePath)).toBe(false);
		sentinel.kill("SIGKILL");
		expect(operation.monitor.stdout?.readableEnded).toBe(true);
		expect(operation.monitor.stderr?.readableEnded).toBe(true);
	}, 10_000);

	it("assigns a fresh generation id and drains output beyond pipe capacity", async () => {
		if (!(await probePidNamespaceContainment())) return;
		const first = await launchPidNamespaceOperation(
			"python3",
			["-c", 'import os,time; os.write(1,b"x"*1048576); time.sleep(60)'],
			{
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const second = await launchPidNamespaceOperation("python3", ["-c", "import time; time.sleep(60)"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		expect(first.generationId).not.toBe(second.generationId);
		await Promise.all([first.killAndWaitVerified(), second.killAndWaitVerified()]);
		expect(first.monitor.stdout?.readableEnded).toBe(true);
	}, 10_000);

	it("reports spawn failure as unavailable containment", async () => {
		await expect(
			launchPidNamespaceOperation("python3", ["-c", "pass"], {}, undefined, {
				spawn: ((_file: string, _args: string[], options: SpawnOptions) =>
					spawn("/prime-agent-missing-unshare", [], options)) as ContainmentSpawn,
				handshakeTimeoutMs: 50,
				reapTimeoutMs: 100,
			}),
		).rejects.toBeInstanceOf(ContainmentUnavailableError);
	});

	it("rejects verified kill when inherited transports do not close", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-containment-reap-test-"));
		tempDirs.push(dir);
		const pidPath = join(dir, "holder.pid");
		const operation = await launchPidNamespaceOperation("python3", ["-c", "pass"], {}, undefined, {
			spawn: ((_file: string, _args: string[], options: SpawnOptions) =>
				spawn(
					"/bin/sh",
					["-c", `printf 'ready:%s\n' $$ >&3; (trap '' HUP TERM; sleep 10) & echo $! > ${pidPath}; wait`],
					options,
				)) as ContainmentSpawn,
			reapTimeoutMs: 100,
		});
		const holderPid = Number(await waitForFile(pidPath));
		await expect(operation.killAndWaitVerified()).rejects.toThrow("did not reap and close transports");
		try {
			process.kill(holderPid, "SIGKILL");
		} catch {
			/* already gone */
		}
		await sleep(50);
	});

	it("does not classify handshake failure as unavailable when cleanup cannot be verified", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-containment-handshake-cleanup-test-"));
		tempDirs.push(dir);
		const pidPath = join(dir, "holder.pid");
		let caught: unknown;
		try {
			await launchPidNamespaceOperation("python3", ["-c", "pass"], {}, undefined, {
				spawn: ((_file: string, _args: string[], options: SpawnOptions) =>
					spawn(
						"/bin/sh",
						["-c", `(trap '' HUP TERM; sleep 10) & echo $! > ${pidPath}; wait`],
						options,
					)) as ContainmentSpawn,
				handshakeTimeoutMs: 20,
				reapTimeoutMs: 100,
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught).not.toBeInstanceOf(ContainmentUnavailableError);
		expect((caught as Error).message).toContain("cleanup was not verified");
		const holderPid = Number(await waitForFile(pidPath));
		try {
			process.kill(holderPid, "SIGKILL");
		} catch {
			/* already gone */
		}
		await sleep(50);
	});

	it("journals the monitor identity and unregisters it after the receipt", async () => {
		if (!(await probePidNamespaceContainment())) return;
		const dir = mkdtempSync(join(tmpdir(), "prime-containment-journal-test-"));
		tempDirs.push(dir);
		const journal = join(dir, "orphans.jsonl");
		const previous = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journal;
		try {
			const operation = await launchPidNamespaceOperation("python3", ["-c", "import time; time.sleep(60)"], {});
			await operation.killAndWaitVerified();
			expect(readActiveOrphanProcesses(journal, process.pid)).toEqual([]);
			expect(readFileSync(journal, "utf8")).toBe("");
		} finally {
			if (previous === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
			else process.env[ORPHAN_PROCESS_JOURNAL_ENV] = previous;
		}
	});

	it("recovers a durably journaled namespace after its owner is SIGKILLed", async () => {
		if (!(await probePidNamespaceContainment())) return;
		const dir = mkdtempSync(join(tmpdir(), "prime-containment-owner-crash-test-"));
		tempDirs.push(dir);
		const journal = join(dir, "orphans.jsonl");
		const readyPath = join(dir, "ready");
		const daemonPidPath = join(dir, "daemon.pid");
		const latePath = join(dir, "late");
		const owner = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				new URL("./fixtures/containment-owner.ts", import.meta.url).pathname,
				readyPath,
				daemonPidPath,
				latePath,
			],
			{
				cwd: process.cwd(),
				env: { ...process.env, [ORPHAN_PROCESS_JOURNAL_ENV]: journal },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		owner.stdout.resume();
		owner.stderr.resume();
		await waitForFile(readyPath);
		const daemonPid = Number(await waitForFile(daemonPidPath));
		owner.kill("SIGKILL");
		await new Promise<void>((resolve) => owner.once("exit", () => resolve()));

		const active = readActiveOrphanProcesses(journal, owner.pid!);
		expect(active).toHaveLength(2);
		expect(active.every(isOrphanProcessIdentityCurrent)).toBe(true);
		expect(await terminateActiveOrphanProcesses(journal, owner.pid!)).toBe(2);
		for (let attempt = 0; attempt < 100 && processIdExists(daemonPid); attempt++) await sleep(20);
		expect(processIdExists(daemonPid)).toBe(false);
		await sleep(1200);
		expect(existsSync(latePath)).toBe(false);
		// Maintained recovery retains cleanup facts until its durable acknowledgement.
		expect(existsSync(journal)).toBe(true);
		clearOrphanProcessJournal(journal);
		expect(existsSync(journal)).toBe(false);
	}, 20_000);
});
