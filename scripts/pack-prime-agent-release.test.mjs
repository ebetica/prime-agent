import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createReleaseManifest,
	createReleasePackageJson,
	normalizePackageVersion,
	npmTarballName,
	releaseTarballUrl,
} from "./pack-prime-agent-release.mjs";

test("keeps stable metadata, manifest, filenames, and R2 URLs on the package version", () => {
	const packageVersion = normalizePackageVersion("0.7.1-recurse.8");
	const stable = `v${packageVersion}`;
	const coreFile = npmTarballName("prime-agent-core", packageVersion);
	const cliFile = npmTarballName("prime-agent", packageVersion);
	const coreUrl = releaseTarballUrl("https://downloads.example", packageVersion, coreFile);
	const packageJson = createReleasePackageJson(
		{
			name: "@earendil-works/pi-coding-agent",
			version: "0.7.0",
			dependencies: { "@earendil-works/pi-agent-core": "^0.7.0" },
		},
		"prime-agent",
		packageVersion,
		new Map([["@earendil-works/pi-agent-core", coreUrl]]),
	);
	const manifest = createReleaseManifest(packageVersion, cliFile, [
		{ name: "prime-agent", file: cliFile, sha256: "abc123" },
	]);

	assert.equal(stable, "v0.7.1-recurse.8");
	assert.equal(packageJson.version, "0.7.1-recurse.8");
	assert.equal(
		packageJson.dependencies["@earendil-works/pi-agent-core"],
		"https://downloads.example/releases/v0.7.1-recurse.8/prime-agent-core-0.7.1-recurse.8.tgz",
	);
	assert.deepEqual(manifest, {
		version: "v0.7.1-recurse.8",
		package: "prime-agent",
		tarball: "releases/v0.7.1-recurse.8/prime-agent-0.7.1-recurse.8.tgz",
		tarballs: [{ package: "prime-agent", file: cliFile, sha256: "abc123" }],
	});
});

test("requires package versions to be valid SemVer", () => {
	assert.equal(normalizePackageVersion("v0.7.1-recurse.8"), "0.7.1-recurse.8");
	assert.throws(() => normalizePackageVersion("0.7.0.8"), /expected SemVer/);
	assert.throws(() => normalizePackageVersion("0.7.1-recurse.08"), /expected SemVer/);
	assert.throws(() => normalizePackageVersion("0.7"), /expected SemVer/);
	assert.throws(() => normalizePackageVersion("01.7.1"), /expected SemVer/);
	assert.throws(() => normalizePackageVersion("0.7.1-"), /expected SemVer/);
	assert.throws(() => normalizePackageVersion("0.7.1+build..1"), /expected SemVer/);
	assert.throws(() => normalizePackageVersion("0.7.1/recurse.8"), /expected SemVer/);
});

test("npm replaces an installed 0.7.0 tarball with the distinct package version", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-package-version-"));
	try {
		const oldTarball = packFixture(tempDir, "old", "0.7.0");
		const newTarball = packFixture(tempDir, "new", "0.7.1-recurse.8");
		const consumerDir = join(tempDir, "consumer");
		mkdirSync(consumerDir);
		writeFileSync(join(consumerDir, "package.json"), '{"name":"consumer","private":true}\n');

		runNpm(["install", "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund", oldTarball], consumerDir);
		assertInstalledPackage(consumerDir, "0.7.0", "old");

		runNpm(["install", "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund", newTarball], consumerDir);
		assertInstalledPackage(consumerDir, "0.7.1-recurse.8", "new");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

function packFixture(tempDir, marker, version) {
	const packageDir = join(tempDir, marker);
	const outputDir = join(tempDir, "tarballs");
	mkdirSync(packageDir);
	mkdirSync(outputDir, { recursive: true });
	writeFileSync(
		join(packageDir, "package.json"),
		`${JSON.stringify({ name: "prime-agent", version, files: ["marker.txt"] })}\n`,
	);
	writeFileSync(join(packageDir, "marker.txt"), `${marker}\n`);
	const output = runNpm(["pack", packageDir, "--pack-destination", outputDir, "--silent"], tempDir);
	return join(outputDir, output.split("\n").at(-1));
}

function assertInstalledPackage(consumerDir, version, marker) {
	const installedDir = join(consumerDir, "node_modules", "prime-agent");
	const packageJson = JSON.parse(readFileSync(join(installedDir, "package.json"), "utf8"));
	assert.equal(packageJson.version, version);
	assert.equal(readFileSync(join(installedDir, "marker.txt"), "utf8"), `${marker}\n`);
}

function runNpm(args, cwd) {
	const result = spawnSync("npm", args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result.stdout.trim();
}
