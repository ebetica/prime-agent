import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./suite/harness.js";

function quote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 5_000;
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
		const token = harness.session.getSessionActionSnapshot().activeRunInstanceId;
		expect(token).toBeDefined();

		expect(await harness.session.stopActiveRun(token!)).toEqual({ status: "stopped" });
		await running;
		await waitFor(() => !alive(child) && !alive(grandchild), "owned process group survived stopped response");
		expect(await harness.session.stopActiveRun(token!)).toEqual({ status: "already_stopped" });
	});
});
