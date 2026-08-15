import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.js";
import { modelSubprocessEnv } from "../src/core/model-subprocess-env.js";
import { createLocalBashOperations } from "../src/core/tools/bash.js";

const HOST_CONTROL_SENTINELS = {
	PRIME_AGENT_INTERNAL_DAEMON_WORKER: "worker",
	PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN: "token",
	PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID: "active",
	PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET: "socket",
	PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL: "recovery",
	PRIME_AGENT_INTERNAL_DAEMON_WORKER_STARTUP_GATE_FD: "3",
	PRIME_AGENT_INTERNAL_DAEMON_CATALOG: "catalog",
	PRIME_AGENT_INTERNAL_OWNED_WORKER: "owned-worker",
	PRIME_AGENT_INTERNAL_OWNED_RECOVERY_DESCRIPTOR: "owned-recovery",
	PRIME_AGENT_INTERNAL_OWNED_PROFILE: "owned-profile",
	PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND: "legacy-owned",
};
const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("model subprocess environment", () => {
	it("removes every host control and restores accounting only from trusted host values", () => {
		const accounting = {
			PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL: "/trusted/orphans",
			PRIME_AGENT_INTERNAL_SESSION_LEASES: "1",
			PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID: "trusted-owner",
		};
		const previous = Object.fromEntries(Object.keys(accounting).map((key) => [key, process.env[key]]));
		Object.assign(process.env, accounting);
		try {
			const environment = modelSubprocessEnv({
				...HOST_CONTROL_SENTINELS,
				SAFE_OVERRIDE: "safe",
				PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL: "/forged/orphans",
				PRIME_AGENT_INTERNAL_SESSION_LEASES: "0",
				PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID: "forged-owner",
				PRIME_AGENT_INTERNAL_UNKNOWN_FUTURE_CONTROL: "future-control",
			});
			expect(
				Object.keys(environment).filter((key) => key.startsWith("PRIME_AGENT_INTERNAL_") && !(key in accounting)),
			).toEqual([]);
			expect(environment).toMatchObject({ SAFE_OVERRIDE: "safe", ...accounting });
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("scrubs extension-provided host capabilities at the local Bash boundary", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-model-bash-env-"));
		tempDirs.push(directory);
		let output = "";
		const result = await createLocalBashOperations().exec(
			"env | grep -E '^PRIME_AGENT_INTERNAL_((DAEMON|OWNED)_|LEGACY_OWNED_)' || true",
			directory,
			{ onData: (data) => (output += data.toString()), env: HOST_CONTROL_SENTINELS },
		);
		expect(result.exitCode).toBe(0);
		expect(output).toBe("");
	});

	it("scrubs host capabilities at the shared exec boundary", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-model-exec-env-"));
		tempDirs.push(directory);
		const result = await execCommand("/usr/bin/env", [], directory, { env: HOST_CONTROL_SENTINELS });
		expect(result.code).toBe(0);
		expect(result.stdout).not.toMatch(/PRIME_AGENT_INTERNAL_(?:(?:DAEMON|OWNED)_|LEGACY_OWNED_)/);
	});
});
