import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.js";
import { modelSubprocessEnv } from "../src/core/model-subprocess-env.js";
import { createLocalBashOperations } from "../src/core/tools/bash.js";

const DAEMON_SENTINELS = {
	PRIME_AGENT_INTERNAL_DAEMON_WORKER: "worker",
	PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN: "token",
	PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID: "active",
	PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET: "socket",
	PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL: "recovery",
	PRIME_AGENT_INTERNAL_DAEMON_WORKER_STARTUP_GATE_FD: "3",
	PRIME_AGENT_INTERNAL_DAEMON_CATALOG: "catalog",
};
const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("model subprocess environment", () => {
	it("removes every daemon control capability after overrides while preserving accounting", () => {
		const environment = modelSubprocessEnv({
			...DAEMON_SENTINELS,
			SAFE_OVERRIDE: "safe",
			PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL: "/tmp/orphans",
			PRIME_AGENT_INTERNAL_SESSION_LEASES: "1",
			PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID: "owner",
		});
		expect(Object.keys(environment).filter((key) => key.startsWith("PRIME_AGENT_INTERNAL_DAEMON_"))).toEqual([]);
		expect(environment).toMatchObject({
			SAFE_OVERRIDE: "safe",
			PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL: "/tmp/orphans",
			PRIME_AGENT_INTERNAL_SESSION_LEASES: "1",
			PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID: "owner",
		});
	});

	it("scrubs extension-provided daemon capabilities at the local Bash boundary", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-model-bash-env-"));
		tempDirs.push(directory);
		let output = "";
		const result = await createLocalBashOperations().exec(
			"env | grep '^PRIME_AGENT_INTERNAL_DAEMON_' || true",
			directory,
			{ onData: (data) => (output += data.toString()), env: DAEMON_SENTINELS },
		);
		expect(result.exitCode).toBe(0);
		expect(output).toBe("");
	});

	it("scrubs daemon capabilities at the shared exec boundary", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-model-exec-env-"));
		tempDirs.push(directory);
		const result = await execCommand("/usr/bin/env", [], directory, { env: DAEMON_SENTINELS });
		expect(result.code).toBe(0);
		expect(result.stdout).not.toContain("PRIME_AGENT_INTERNAL_DAEMON_");
	});
});
