#!/usr/bin/env node

// TODO: Remove this R2 tarball packer once prime-agent and its internal workspace
// dependencies are published through a real npm release flow.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	renameSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutputDir = join(root, "packages", "coding-agent", "release");
const defaultBaseUrl = process.env.PRIME_AGENT_DOWNLOAD_BASE_URL;
const publicPackageName = process.env.PRIME_AGENT_PACKAGE_NAME || "prime-agent";
const publicCommandName = process.env.PRIME_AGENT_CMD || "prime-agent";
const releaseChannels = new Set(["stable", "beta"]);

const releasePackages = [
	{ packageDir: "ai", publicName: undefined, artifactName: "prime-agent-ai" },
	{ packageDir: "tui", publicName: undefined, artifactName: "prime-agent-tui" },
	{ packageDir: "agent", publicName: undefined, artifactName: "prime-agent-core" },
	{ packageDir: "coding-agent", publicName: publicPackageName, artifactName: publicPackageName },
];

function parseArgs(args) {
	const parsed = {
		baseUrl: defaultBaseUrl,
		channel: "stable",
		outDir: defaultOutputDir,
		releaseTag: undefined,
		version: undefined,
	};

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		switch (arg) {
			case "--channel": {
				const value = args[i + 1];
				if (!value || !releaseChannels.has(value)) {
					throw new Error("--channel must be stable or beta");
				}
				parsed.channel = value;
				i += 1;
				break;
			}
			case "--base-url": {
				const value = args[i + 1];
				if (!value) throw new Error("--base-url requires a value");
				parsed.baseUrl = value;
				i += 1;
				break;
			}
			case "--out-dir": {
				const value = args[i + 1];
				if (!value) throw new Error("--out-dir requires a value");
				parsed.outDir = resolve(root, value);
				i += 1;
				break;
			}
			case "--version": {
				const value = args[i + 1];
				if (!value) throw new Error("--version requires a value");
				parsed.version = normalizePackageVersion(value);
				i += 1;
				break;
			}
			case "--release-tag": {
				const value = args[i + 1];
				if (!value) throw new Error("--release-tag requires a value");
				parsed.releaseTag = normalizeReleaseTag(value);
				i += 1;
				break;
			}
			case "--help":
			case "-h":
				printHelp();
				process.exit(0);
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!parsed.baseUrl) {
		throw new Error("--base-url or PRIME_AGENT_DOWNLOAD_BASE_URL is required");
	}

	parsed.baseUrl = parsed.baseUrl.replace(/\/+$/, "");
	return parsed;
}

function printHelp() {
	console.log(`Usage: node scripts/pack-prime-agent-release.mjs --base-url url [--channel stable|beta] [--version semver] [--release-tag tag] [--out-dir path]

Creates private npm tarballs for R2 distribution. --version selects package.json
versions and filenames. --release-tag selects the release download path and defaults
to v<version> for compatibility.

  <out-dir>/artifacts/prime-agent-<version>.tgz
  <out-dir>/artifacts/prime-agent-ai-<version>.tgz
  <out-dir>/artifacts/prime-agent-core-<version>.tgz
  <out-dir>/artifacts/prime-agent-tui-<version>.tgz
  <out-dir>/artifacts/SHA256SUMS
  <out-dir>/artifacts/<channel>
  <out-dir>/artifacts/latest.json (stable) or beta.json (beta)
`);
}

export function normalizeReleaseTag(tag) {
	const normalized = tag.startsWith("v") ? tag.slice(1) : tag;
	if (!/^[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*$/.test(normalized)) {
		throw new Error(`Invalid release tag: ${tag}`);
	}
	return `v${normalized}`;
}

export function normalizePackageVersion(version) {
	const normalized = version.startsWith("v") ? version.slice(1) : version;
	const identifier = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
	const semver = new RegExp(
		`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
	);
	if (!semver.test(normalized)) {
		throw new Error(`Invalid package version (expected SemVer): ${version}`);
	}
	return normalized;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function packagePath(packageDir) {
	return join(root, "packages", packageDir);
}

function assertSafeOutputDir(outDir) {
	const relativeToReleaseRoot = relative(defaultOutputDir, outDir);
	if (relativeToReleaseRoot === "" || (!relativeToReleaseRoot.startsWith("..") && !isAbsolute(relativeToReleaseRoot))) {
		return;
	}
	throw new Error(`Refusing to remove output directory outside ${defaultOutputDir}: ${outDir}`);
}

function packageJsonPath(packageDir) {
	return join(packagePath(packageDir), "package.json");
}

function requireBuiltPackage(packageDir) {
	const dist = join(packagePath(packageDir), "dist");
	if (!existsSync(dist)) {
		throw new Error(`Missing ${dist}. Run npm run build before packing a release.`);
	}
}

function copyIfExists(source, target) {
	if (existsSync(source)) {
		cpSync(source, target, { recursive: true });
	}
}

export function npmTarballName(packageName, version) {
	return `${packageName.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

export function releaseTarballUrl(baseUrl, releaseTag, tarballFile) {
	return `${baseUrl}/releases/${releaseTag}/${tarballFile}`;
}

function rewriteInternalDependencies(dependencies, internalPackageUrls) {
	if (!dependencies) return undefined;
	const rewritten = {};
	for (const [name, range] of Object.entries(dependencies)) {
		rewritten[name] = internalPackageUrls.get(name) || range;
	}
	return rewritten;
}

function releaseScripts(sourceScripts) {
	if (!sourceScripts?.postinstall) return undefined;
	return {
		postinstall: sourceScripts.postinstall,
	};
}

export function createReleasePackageJson(sourcePackage, packageName, packageVersion, internalPackageUrls) {
	const packageJson = {
		...sourcePackage,
		name: packageName,
		version: packageVersion,
		dependencies: rewriteInternalDependencies(sourcePackage.dependencies, internalPackageUrls),
		optionalDependencies: rewriteInternalDependencies(sourcePackage.optionalDependencies, internalPackageUrls),
		scripts: releaseScripts(sourcePackage.scripts),
	};

	delete packageJson.devDependencies;
	delete packageJson.overrides;
	delete packageJson.private;

	if (packageName === publicPackageName) {
		packageJson.bin = {
			[publicCommandName]: "dist/bundle/cli.js",
		};
		packageJson.piConfig = {
			...(packageJson.piConfig || {}),
			name: publicCommandName,
			configDir: ".prime/agent",
		};
	}

	return packageJson;
}

function copyPackageContents(sourceDir, targetDir, packageJson) {
	mkdirSync(targetDir, { recursive: true });
	writeJson(join(targetDir, "package.json"), packageJson);

	for (const entry of ["dist", "docs", "examples", "skills", "postinstall.cjs", "README.md", "CHANGELOG.md"]) {
		copyIfExists(join(sourceDir, entry), join(targetDir, entry));
	}
}

function run(command, args, cwd) {
	const result = spawnSync(command, args, {
		cwd,
		stdio: "pipe",
		encoding: "utf8",
	});

	if (result.status !== 0) {
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
	}

	if (result.stderr) process.stderr.write(result.stderr);
	return result.stdout.trim();
}

function sha256File(path) {
	const hash = createHash("sha256");
	hash.update(readFileSync(path));
	return hash.digest("hex");
}

export function createReleaseManifest(packageVersion, releaseTag, cliArtifactFile, tarballs) {
	return {
		version: `v${packageVersion}`,
		releaseTag,
		package: publicPackageName,
		tarball: `releases/${releaseTag}/${cliArtifactFile}`,
		tarballs: tarballs.map((tarball) => ({
			package: tarball.name,
			file: tarball.file,
			sha256: tarball.sha256,
		})),
	};
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const sourcePackages = new Map(
		releasePackages.map((releasePackage) => [
			releasePackage.packageDir,
			readJson(packageJsonPath(releasePackage.packageDir)),
		]),
	);
	const cliPackage = sourcePackages.get("coding-agent");
	const packageVersion = args.version || normalizePackageVersion(process.env.PRIME_AGENT_VERSION || cliPackage.version);
	const releaseTag = args.releaseTag || `v${packageVersion}`;

	for (const releasePackage of releasePackages) {
		requireBuiltPackage(releasePackage.packageDir);
	}

	// Dependency keys stay on the source package names so existing compiled imports
	// keep resolving, while release package names and artifact filenames are branded.
	const sourcePackageNames = new Map();
	const packageNames = new Map();
	const artifactFiles = new Map();
	for (const releasePackage of releasePackages) {
		const sourcePackage = sourcePackages.get(releasePackage.packageDir);
		const packageName = releasePackage.publicName || releasePackage.artifactName || sourcePackage.name;
		sourcePackageNames.set(releasePackage.packageDir, sourcePackage.name);
		packageNames.set(releasePackage.packageDir, packageName);
		artifactFiles.set(
			releasePackage.packageDir,
			npmTarballName(releasePackage.artifactName || packageName, packageVersion),
		);
	}

	const internalPackageUrls = new Map();
	for (const releasePackage of releasePackages) {
		if (releasePackage.packageDir === "coding-agent") continue;
		const sourcePackageName = sourcePackageNames.get(releasePackage.packageDir);
		const artifactFile = artifactFiles.get(releasePackage.packageDir);
		internalPackageUrls.set(sourcePackageName, releaseTarballUrl(args.baseUrl, releaseTag, artifactFile));
	}

	const stagingRoot = join(args.outDir, "packages");
	const artifactsDir = join(args.outDir, "artifacts");
	assertSafeOutputDir(args.outDir);
	rmSync(args.outDir, { force: true, recursive: true });
	mkdirSync(stagingRoot, { recursive: true });
	mkdirSync(artifactsDir, { recursive: true });

	const tarballs = [];
	for (const releasePackage of releasePackages) {
		const sourcePackage = sourcePackages.get(releasePackage.packageDir);
		const packageName = packageNames.get(releasePackage.packageDir);
		const stagingDir = join(stagingRoot, releasePackage.packageDir);
		const packageJson = createReleasePackageJson(
			sourcePackage,
			packageName,
			packageVersion,
			internalPackageUrls,
		);

		copyPackageContents(packagePath(releasePackage.packageDir), stagingDir, packageJson);

		const tarballName = run("npm", ["pack", stagingDir, "--pack-destination", artifactsDir, "--silent"], root)
			.split("\n")
			.at(-1);
		if (!tarballName) {
			throw new Error(`npm pack did not report a tarball name for ${packageName}`);
		}

		const tarballPath = join(artifactsDir, basename(tarballName));
		if (!existsSync(tarballPath) || !statSync(tarballPath).isFile()) {
			throw new Error(`npm pack did not create ${tarballPath}`);
		}

		const artifactFile = artifactFiles.get(releasePackage.packageDir);
		const artifactPath = join(artifactsDir, artifactFile);
		if (tarballPath !== artifactPath) {
			rmSync(artifactPath, { force: true });
			renameSync(tarballPath, artifactPath);
		}

		tarballs.push({
			name: packageName,
			file: artifactFile,
			sha256: sha256File(artifactPath),
		});
	}

	tarballs.sort((left, right) => left.file.localeCompare(right.file));
	writeFileSync(
		join(artifactsDir, "SHA256SUMS"),
		tarballs.map((tarball) => `${tarball.sha256}  ${tarball.file}`).join("\n") + "\n",
	);
	writeFileSync(join(artifactsDir, args.channel), `v${packageVersion}\n`);
	const manifestName = args.channel === "stable" ? "latest.json" : "beta.json";
	writeJson(
		join(artifactsDir, manifestName),
		createReleaseManifest(packageVersion, releaseTag, artifactFiles.get("coding-agent"), tarballs),
	);

	for (const tarball of tarballs) {
		console.log(`Created ${join(artifactsDir, tarball.file)}`);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
