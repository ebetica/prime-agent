import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_RLM_EXTRA_IMPORT_NAMES,
	DEFAULT_RLM_EXTRA_UV_ARGS,
	ensureKernelPython,
	getKernelVenvDir,
	type KernelPythonSkill,
	kernelEnvironmentName,
	resolveRuntimeIdentity,
} from "../src/core/kernel/bootstrap.js";

const execFileAsync = promisify(execFile);

let tempDir = "";
let originalEnv: NodeJS.ProcessEnv;
let runtimeIdentity = "";

function kernelVenv(pythonSkills: readonly KernelPythonSkill[] = [], pythonVersion = "3.11"): string {
	return join(getKernelVenvDir(), kernelEnvironmentName(runtimeIdentity, pythonSkills, pythonVersion));
}

function packageHash(packagePath: string): string {
	const files: string[] = [];
	const collect = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) collect(fullPath);
			else if (entry.isFile()) files.push(fullPath);
		}
	};
	collect(packagePath);
	const hash = createHash("sha256");
	for (const file of files.sort()) {
		hash.update(relative(packagePath, file));
		hash.update("\0");
		hash.update(readFileSync(file));
		hash.update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}

function pyprojectHash(pyprojectPath: string): string {
	return `sha256:${createHash("sha256").update(readFileSync(pyprojectPath)).digest("hex")}`;
}

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
}

function writeBootstrapVersion(venv: string, pythonSkills: readonly KernelPythonSkill[] = []): void {
	writeFileSync(
		join(venv, ".bootstrap-version"),
		`${JSON.stringify({
			schema: 9,
			ipykernel: "ipykernel",
			runtime: runtimeIdentity,
			snapshot: "dill",
			extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
			pythonSkills: pythonSkills.map((skill) => ({
				importName: skill.importName,
				packagePath: skill.packagePath,
				pyprojectPath: skill.pyprojectPath,
				pyprojectHash: pyprojectHash(skill.pyprojectPath),
				packageHash: packageHash(skill.packagePath),
			})),
		})}\n`,
	);
}

function createPythonSkill(name = "web-search"): KernelPythonSkill {
	const packagePath = join(tempDir, "skills", name);
	const importName = name.replaceAll("-", "_");
	const pyprojectPath = join(packagePath, "pyproject.toml");
	mkdirSync(join(packagePath, "src", importName), { recursive: true });
	writeFileSync(
		pyprojectPath,
		`[project]
name = "${name}"
version = "0.1.0"
`,
	);
	writeFileSync(join(packagePath, "src", importName, "__init__.py"), "async def run():\n    return 'ok'\n");
	return {
		name,
		importName,
		packagePath,
		pyprojectPath,
	};
}

function createPythonSkillWithDependency(name: string, dependencyName: string): KernelPythonSkill {
	const skill = createPythonSkill(name);
	writeFileSync(
		skill.pyprojectPath,
		`[project]
name = "${name}"
version = "0.1.0"
dependencies = ["${dependencyName}"]
`,
	);
	return skill;
}

function writeFakePython(filePath: string, importableModules: readonly string[]): void {
	const cases = importableModules.map((moduleName) => `    "import ${moduleName}") exit 0 ;;`).join("\n");
	const runtimeCase = importableModules.includes("rlm") ? '    *"_harness_methods"*) exit 0 ;;' : "";
	writeExecutable(
		filePath,
		[
			"#!/bin/sh",
			'if [ "$1" = "-I" ]; then shift; fi',
			'if [ "$1" = "-c" ]; then',
			'  case "$2" in',
			cases,
			runtimeCase,
			"    *) exit 1 ;;",
			"  esac",
			"fi",
			"exit 0",
			"",
		].join("\n"),
	);
}

function installFakeUv(): string {
	const binDir = join(tempDir, "bin");
	mkdirSync(binDir, { recursive: true });
	const logPath = join(tempDir, "uv.log");
	const extraImportCases = DEFAULT_RLM_EXTRA_IMPORT_NAMES.map((moduleName) => `    "import ${moduleName}") exit 0 ;;`);
	process.env.UV_LOG = logPath;
	process.env.PATH = `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
	writeExecutable(
		join(binDir, "uv"),
		[
			"#!/bin/sh",
			"set -e",
			'printf "%s\\n" "$*" >> "$UV_LOG"',
			'if [ "$1" = "python" ]; then',
			"  exit 0",
			"fi",
			'if [ "$1" = "venv" ]; then',
			'  venv="$2"',
			'  mkdir -p "$venv/bin"',
			"  cat > \"$venv/bin/python\" <<'PY'",
			"#!/bin/sh",
			'if [ "$1" = "-I" ]; then shift; fi',
			'if [ "$1" = "-c" ]; then',
			'  case "$2" in',
			'    "import ipykernel"|"import rlm") exit 0 ;;',
			...extraImportCases,
			'    "import "*) exit 0 ;;',
			'    *"_harness_methods"*) exit 0 ;;',
			"    *) exit 1 ;;",
			"  esac",
			"fi",
			"exit 0",
			"PY",
			'  chmod +x "$venv/bin/python"',
			"  exit 0",
			"fi",
			'if [ "$1" = "pip" ]; then',
			'  for arg in "$@"; do',
			'    if [ "$UV_FAIL_ARG" != "" ] && echo "$arg" | grep -Fq "$UV_FAIL_ARG"; then',
			"      exit 1",
			"    fi",
			"  done",
			"  exit 0",
			"fi",
			"exit 2",
			"",
		].join("\n"),
	);
	return logPath;
}

describe("kernel bootstrap", () => {
	beforeEach(async () => {
		runtimeIdentity = await resolveRuntimeIdentity();
		originalEnv = { ...process.env };
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-bootstrap-"));
		process.env.HOME = tempDir;
		process.env.PATH = originalEnv.PATH ?? "";
		delete process.env.PRIME_AGENT_KERNEL_PYTHON;
		process.env.PRIME_AGENT_KERNEL_VENV = join(tempDir, "kernel-venvs");
		delete process.env.XDG_DATA_HOME;
	});

	afterEach(() => {
		process.env = originalEnv;
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("returns the configured kernel venv directory", () => {
		const venv = join(tempDir, "custom-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		expect(getKernelVenvDir()).toBe(venv);
	});

	it("bootstraps a missing venv with uv, ipykernel, prime-agent-runtime, and default extra packages", async () => {
		const logPath = installFakeUv();
		const venv = kernelVenv();

		await expect(ensureKernelPython()).resolves.toBe(join(venv, "bin", "python"));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain("python install 3.11");
		expect(log).toContain(`venv ${venv}.building-`);
		expect(log).toContain("pip install --python");
		expect(log).toContain("ipykernel");
		expect(log).toContain(".runtime-source");
		expect(log).toContain("dill");
		for (const uvArg of DEFAULT_RLM_EXTRA_UV_ARGS) {
			expect(log).toContain(uvArg);
		}
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version).toEqual({
			schema: 9,
			ipykernel: "ipykernel",
			runtime: runtimeIdentity,
			snapshot: "dill",
			extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
			pythonSkills: [],
		});
		expect(version.runtime).toMatch(/^sha256:/);
	});

	it("routes bootstrap progress through the provided callback", async () => {
		installFakeUv();
		const venv = kernelVenv();
		const progress: string[] = [];
		const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		try {
			await expect(ensureKernelPython({ onProgress: (message) => progress.push(message) })).resolves.toBe(
				join(venv, "bin", "python"),
			);
		} finally {
			stderrWrite.mockRestore();
		}

		expect(progress).toEqual(expect.arrayContaining(["› setting up python kernel (one-time, ~30s)…", "✓ ready"]));
		expect(stderrWrite).not.toHaveBeenCalledWith(expect.stringContaining("setting up python kernel"));
		expect(stderrWrite).not.toHaveBeenCalledWith(expect.stringContaining("ready"));
	});

	it("installs Python skills into the bootstrapped venv", async () => {
		const logPath = installFakeUv();
		const pythonSkill = createPythonSkill();
		const venv = kernelVenv([pythonSkill]);

		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(join(venv, "bin", "python"));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(".skill-sources/0");
		expect(log).not.toContain(pythonSkill.packagePath);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills).toEqual([
			{
				importName: pythonSkill.importName,
				packagePath: pythonSkill.packagePath,
				pyprojectPath: pythonSkill.pyprojectPath,
				pyprojectHash: pyprojectHash(pythonSkill.pyprojectPath),
				packageHash: packageHash(pythonSkill.packagePath),
			},
		]);
	});

	it("installs sibling Python skill dependencies with dependent editable packages", async () => {
		const logPath = installFakeUv();
		const dependencySkill = createPythonSkill("agent-observe");
		const dependentSkill = createPythonSkillWithDependency("orchestration-heartbeat", "agent-observe");
		const venv = kernelVenv([dependentSkill]);

		await expect(ensureKernelPython({ pythonSkills: [dependentSkill] })).resolves.toBe(join(venv, "bin", "python"));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(".skill-sources/0");
		expect(log).toContain(".skill-sources/1");
		expect(log).not.toContain(dependencySkill.packagePath);
		expect(log).not.toContain(dependentSkill.packagePath);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills).toEqual([
			{
				importName: dependencySkill.importName,
				packagePath: dependencySkill.packagePath,
				pyprojectPath: dependencySkill.pyprojectPath,
				pyprojectHash: pyprojectHash(dependencySkill.pyprojectPath),
				packageHash: packageHash(dependencySkill.packagePath),
			},
			{
				importName: dependentSkill.importName,
				packagePath: dependentSkill.packagePath,
				pyprojectPath: dependentSkill.pyprojectPath,
				pyprojectHash: pyprojectHash(dependentSkill.pyprojectPath),
				packageHash: packageHash(dependentSkill.packagePath),
			},
		]);
	});

	it("installs sibling Python skill dependencies when package and directory names differ", async () => {
		const logPath = installFakeUv();
		const dependencySkill = createPythonSkill("attach-image");
		writeFileSync(
			dependencySkill.pyprojectPath,
			`[project]
name = "prime-agent-skill-attach-image"
version = "0.1.0"
`,
		);
		const dependentSkill = createPythonSkillWithDependency(
			"orchestration-heartbeat",
			"prime-agent-skill-attach-image",
		);
		const venv = kernelVenv([dependentSkill]);

		await expect(ensureKernelPython({ pythonSkills: [dependentSkill] })).resolves.toBe(join(venv, "bin", "python"));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(".skill-sources/0");
		expect(log).toContain(".skill-sources/1");
		expect(log).not.toContain(dependencySkill.packagePath);
		expect(log).not.toContain(dependentSkill.packagePath);
	});

	it("parses Python skill dependencies with extras", async () => {
		const logPath = installFakeUv();
		const dependencySkill = createPythonSkill("gidgethub");
		const dependentSkill = createPythonSkillWithDependency("orchestration-heartbeat", "gidgethub[httpx]>4.0.0");
		const venv = kernelVenv([dependentSkill]);

		await expect(ensureKernelPython({ pythonSkills: [dependentSkill] })).resolves.toBe(join(venv, "bin", "python"));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(".skill-sources/0");
		expect(log).toContain(".skill-sources/1");
		expect(log).not.toContain(dependencySkill.packagePath);
		expect(log).not.toContain(dependentSkill.packagePath);
	});

	it("uses different immutable environments for runtime, skill, and Python-minor changes", () => {
		const skill = createPythonSkill();
		const same = kernelEnvironmentName(runtimeIdentity, [skill], "3.11");
		expect(kernelEnvironmentName(runtimeIdentity, [skill], "3.11")).toBe(same);
		expect(kernelEnvironmentName("sha256:different-runtime", [skill], "3.11")).not.toBe(same);
		expect(kernelEnvironmentName(runtimeIdentity, [skill], "3.12")).not.toBe(same);
		writeFileSync(
			join(skill.packagePath, "src", skill.importName, "__init__.py"),
			"async def run():\n    return 'changed'\n",
		);
		expect(kernelEnvironmentName(runtimeIdentity, [skill], "3.11")).not.toBe(same);
	});

	it("includes sibling Python skill dependency source in the environment identity", () => {
		const dependency = createPythonSkill("dependency-skill");
		const dependent = createPythonSkillWithDependency("dependent-skill", "dependency-skill");
		const before = kernelEnvironmentName(runtimeIdentity, [dependent]);

		writeFileSync(
			join(dependency.packagePath, "src", dependency.importName, "__init__.py"),
			"async def run():\n    return 'changed dependency'\n",
		);

		expect(kernelEnvironmentName(runtimeIdentity, [dependent])).not.toBe(before);
	});

	it("leaves an active old interpreter usable while a new runtime environment bootstraps", async () => {
		const logPath = installFakeUv();
		const root = getKernelVenvDir();
		const oldVenv = join(root, kernelEnvironmentName("sha256:old-runtime"));
		const oldPython = join(oldVenv, "bin", "python");
		const ready = join(oldVenv, "ready");
		const release = join(oldVenv, "release");
		const result = join(oldVenv, "result");
		mkdirSync(join(oldVenv, "bin"), { recursive: true });
		writeFileSync(join(oldVenv, "sentinel"), "still running");
		writeExecutable(
			oldPython,
			`#!/bin/sh
set -e
: > ${JSON.stringify(ready)}
while [ ! -e ${JSON.stringify(release)} ]; do sleep 0.01; done
cat ${JSON.stringify(join(oldVenv, "sentinel"))} > ${JSON.stringify(result)}
`,
		);
		const activeOldInterpreter = spawn(oldPython, [], { stdio: "ignore" });
		const activeOldExit = new Promise<void>((resolvePromise, reject) => {
			activeOldInterpreter.once("exit", (code) =>
				code === 0 ? resolvePromise() : reject(new Error(`exit ${code}`)),
			);
		});
		for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt++) {
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
		}
		expect(existsSync(ready)).toBe(true);

		const currentPython = await ensureKernelPython();

		expect(currentPython).toBe(join(kernelVenv(), "bin", "python"));
		expect(activeOldInterpreter.exitCode).toBeNull();
		expect(readFileSync(join(oldVenv, "sentinel"), "utf8")).toBe("still running");
		expect(readFileSync(logPath, "utf8")).not.toContain(oldVenv);
		writeFileSync(release, "release");
		await activeOldExit;
		expect(readFileSync(result, "utf8")).toBe("still running");
	});

	it("never recursively cleans or rewrites an old environment during startup", async () => {
		installFakeUv();
		const oldVenv = join(getKernelVenvDir(), "old-environment-py3.11");
		mkdirSync(oldVenv, { recursive: true });
		writeFileSync(join(oldVenv, "sentinel"), "preserved");

		await ensureKernelPython();

		expect(readFileSync(join(oldVenv, "sentinel"), "utf8")).toBe("preserved");
	});

	it("publishes no partial environment when a Python skill install fails", async () => {
		const logPath = installFakeUv();
		const skill = createPythonSkill("retry-skill");
		const venv = kernelVenv([skill]);
		process.env.UV_FAIL_ARG = ".skill-sources/";

		await expect(ensureKernelPython({ pythonSkills: [skill] })).rejects.toThrow("Python skill installation failed");
		expect(existsSync(venv)).toBe(false);
		expect(readdirSync(getKernelVenvDir()).some((entry) => entry.includes(".building-"))).toBe(false);

		delete process.env.UV_FAIL_ARG;
		await expect(ensureKernelPython({ pythonSkills: [skill] })).resolves.toBe(join(venv, "bin", "python"));
		const creates = readFileSync(logPath, "utf8")
			.split("\n")
			.filter((line) => line.includes(".building-") && line.startsWith("venv "));
		expect(creates).toHaveLength(2);
	});

	it("shares concurrent bootstrap work in one process", async () => {
		const logPath = installFakeUv();
		const venv = kernelVenv();
		const python = join(venv, "bin", "python");

		await expect(Promise.all([ensureKernelPython(), ensureKernelPython()])).resolves.toEqual([python, python]);

		const log = readFileSync(logPath, "utf8");
		expect(log.split("\n").filter((line) => line.startsWith(`venv ${venv}.building-`))).toHaveLength(1);
	});

	it("serializes the same immutable environment across processes", async () => {
		const logPath = installFakeUv();
		const script = join(tempDir, "bootstrap.ts");
		const bootstrapPath = resolve(process.cwd(), "src/core/kernel/bootstrap.ts");
		writeFileSync(
			script,
			`import { ensureKernelPython } from ${JSON.stringify(bootstrapPath)};\nvoid (async () => ensureKernelPython())();\n`,
		);
		const tsx = resolve(process.cwd(), "../../node_modules/.bin/tsx");

		await Promise.all([
			execFileAsync(tsx, [script], { cwd: process.cwd(), env: process.env }),
			execFileAsync(tsx, [script], { cwd: process.cwd(), env: process.env }),
		]);

		const venv = kernelVenv();
		const creates = readFileSync(logPath, "utf8")
			.split("\n")
			.filter((line) => line.startsWith(`venv ${venv}.building-`));
		expect(creates).toHaveLength(1);
		expect(existsSync(join(venv, "bin", "python"))).toBe(true);
	});

	it("reuses a current warm venv without invoking uv", async () => {
		const venv = kernelVenv();
		const python = join(venv, "bin", "python");
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["ipykernel", "rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeBootstrapVersion(venv);

		await expect(ensureKernelPython()).resolves.toBe(python);
	});

	it("fails closed without rewriting an invalid immutable environment", async () => {
		const logPath = installFakeUv();
		const venv = kernelVenv();
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFileSync(join(venv, "sentinel"), "do not replace");

		await expect(ensureKernelPython()).rejects.toThrow("immutable kernel environment is incomplete or invalid");

		expect(readFileSync(join(venv, "sentinel"), "utf8")).toBe("do not replace");
		expect(existsSync(logPath)).toBe(false);
	});

	it("uses PRIME_AGENT_KERNEL_PYTHON as an override contract", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, ["ipykernel", "rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).resolves.toBe(overridePython);
	});

	it("isolates bootstrap probes from model cwd and host control capabilities", async () => {
		const overridePython = join(tempDir, "override-python");
		const logPath = join(tempDir, "probe.log");
		writeExecutable(
			overridePython,
			`#!/bin/sh
printf '%s|%s|%s|%s\n' "$PWD" "\${PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN-unset}" "\${PRIME_AGENT_INTERNAL_OWNED_RECOVERY_DESCRIPTOR-unset}" "$*" >> ${JSON.stringify(logPath)}
exit 0
`,
		);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;
		process.env.PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN = "daemon-token";
		process.env.PRIME_AGENT_INTERNAL_OWNED_RECOVERY_DESCRIPTOR = "owned-descriptor";

		await expect(ensureKernelPython()).resolves.toBe(overridePython);

		const records = readFileSync(logPath, "utf8").trim().split("\n");
		expect(records.length).toBeGreaterThan(1);
		for (const record of records) {
			const [cwd, daemonControl, ownedControl, args] = record.split("|");
			expect(cwd).toBe(parse(process.execPath).root);
			expect(daemonControl).toBe("unset");
			expect(ownedControl).toBe("unset");
			expect(args).toMatch(/^-I -c /);
		}
	});

	it("allows PRIME_AGENT_KERNEL_PYTHON missing Python skill imports", async () => {
		const overridePython = join(tempDir, "override-python");
		const pythonSkill = createPythonSkill();
		writeFakePython(overridePython, ["ipykernel", "rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(overridePython);
	});

	it("rejects PRIME_AGENT_KERNEL_PYTHON missing default extra packages", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, [
			"ipykernel",
			"rlm",
			...DEFAULT_RLM_EXTRA_IMPORT_NAMES.filter((name) => name !== "yaml"),
		]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/default Python packages \(yaml \(PyYAML\)\)/);
	});

	it("rejects PRIME_AGENT_KERNEL_PYTHON with a stale rlm runtime", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, ["ipykernel"]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/current prime-agent-runtime with callable rlm\.run/);
	});

	it("rejects PRIME_AGENT_KERNEL_PYTHON with a legacy harness API", async () => {
		const overridePython = join(tempDir, "override-python");
		writeExecutable(
			overridePython,
			[
				"#!/bin/sh",
				'if [ "$1" = "-I" ]; then shift; fi',
				'if [ "$1" = "-c" ]; then',
				'  case "$2" in',
				'    "import ipykernel"|"import rlm") exit 0 ;;',
				'    *"_harness_methods"*) exit 1 ;;',
				"    *\"assert not hasattr(rlm.rlm, 'background')\"*) exit 0 ;;",
				"    *) exit 1 ;;",
				"  esac",
				"fi",
				"exit 0",
				"",
			].join("\n"),
		);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/current prime-agent-runtime with callable rlm\.run/);
	});

	it("fails an invalid PRIME_AGENT_KERNEL_PYTHON without bootstrapping", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, []);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/missing ipykernel/);
	});
});
