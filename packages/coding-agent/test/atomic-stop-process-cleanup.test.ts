import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ORPHAN_PROCESS_JOURNAL_ENV } from "../src/core/orphan-process-journal.js";
import { createHarness, type Harness } from "./suite/harness.js";

function quote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(message);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(process.platform === "win32")("atomic stop process cleanup", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("settles only after a user Bash child and grandchild process group is gone", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const dir = mkdtempSync(join(tmpdir(), "atomic-stop-"));
		dirs.push(dir);
		const childFile = join(dir, "child.pid");
		const grandchildFile = join(dir, "grandchild.pid");
		const command = `sh -c 'echo $$ > ${quote(childFile)}; sleep 60 & echo $! > ${quote(grandchildFile)}; wait'`;
		const running = harness.session.runUserBash(command);
		await waitFor(() => existsSync(childFile) && existsSync(grandchildFile), "processes did not start");
		const child = Number(readFileSync(childFile, "utf8"));
		const grandchild = Number(readFileSync(grandchildFile, "utf8"));
		const token = harness.session.getSessionActionSnapshot().activeOperationSet?.token;
		expect(token).toBeDefined();

		expect(await harness.session.stopActiveOperations(token!)).toEqual({ status: "stopped" });
		await running;
		await waitFor(() => !alive(child) && !alive(grandchild), "owned process group survived stopped response");
		expect(await harness.session.stopActiveOperations(token!)).toEqual({
			status: "already_stopped",
		});
	});

	it("reaps the exact active IPython generation before stopped returns", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-stop-kernel-"));
		dirs.push(dir);
		const childFile = join(dir, "kernel-child.pid");
		const previousJournal = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		const previousForkserver = process.env.PRIME_AGENT_KERNEL_FORKSERVER;
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = join(dir, "orphans.jsonl");
		process.env.PRIME_AGENT_KERNEL_FORKSERVER = "0";
		const harness = await createHarness();
		harnesses.push(harness);
		try {
			const code = `
import subprocess, sys, time
subprocess.Popen([sys.executable, "-c", ${JSON.stringify(
				`import os, time; os.setsid(); open(${JSON.stringify(childFile)}, "w").write(str(os.getpid())); time.sleep(60)`,
			)}])
time.sleep(60)
`;
			harness.setResponses([fauxAssistantMessage(fauxToolCall("ipython", { code }), { stopReason: "toolUse" })]);
			const prompt = harness.session.prompt("start kernel work");
			await waitFor(() => existsSync(childFile), "kernel descendant did not start", 20_000);
			const child = Number(readFileSync(childFile, "utf8"));
			const token = harness.session.getSessionActionSnapshot().activeOperationSet?.token;
			expect(token).toBeDefined();

			expect(await harness.session.stopActiveOperations(token!)).toEqual({ status: "stopped" });
			await prompt;
			await waitFor(() => !alive(child), "active kernel descendant survived stopped response");
		} finally {
			if (previousJournal === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
			else process.env[ORPHAN_PROCESS_JOURNAL_ENV] = previousJournal;
			if (previousForkserver === undefined) delete process.env.PRIME_AGENT_KERNEL_FORKSERVER;
			else process.env.PRIME_AGENT_KERNEL_FORKSERVER = previousForkserver;
		}
	}, 30_000);
});
