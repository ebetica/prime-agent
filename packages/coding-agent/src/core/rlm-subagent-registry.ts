/**
 * Durable RLM child registry storage.
 *
 * This file is live state, not an audit log. Legacy append-only files are read
 * once and compacted under the same cross-process lock used by every writer.
 * Atomic replacement keeps one latest row per discoverable child; deletion
 * removes its row, so both storage and steady-state operations are O(live).
 */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const registryQueues = new Map<string, Promise<void>>();
async function withRegistryOwner<T>(path: string, action: () => T | Promise<T>): Promise<T> {
	const key = resolve(path);
	const previous = registryQueues.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolveRelease) => {
		release = resolveRelease;
	});
	const tail = previous.then(() => current);
	registryQueues.set(key, tail);
	await previous;
	try {
		return await action();
	} finally {
		release();
		if (registryQueues.get(key) === tail) registryQueues.delete(key);
	}
}

export interface PersistedRlmSubagentRegistryEntry {
	type: "rlm_subagent";
	childId: string;
	sessionName: string;
	sessionDir: string;
	sessionFile: string;
	parentSessionId: string;
	parentSessionFile?: string;
	rlmDepth?: number;
	rlmMaxDepth?: number;
	rlmParentNodeId?: string;
	prompt?: string;
	spawnCode?: string;
	model?: { provider: string; modelId: string };
	status: "running" | "completed" | "interrupted" | "deleted";
	createdAt: number;
	updatedAt: string;
}

function parseEntry(line: string): PersistedRlmSubagentRegistryEntry | undefined {
	const entry = JSON.parse(line) as Partial<PersistedRlmSubagentRegistryEntry>;
	if (
		entry.type !== "rlm_subagent" ||
		typeof entry.childId !== "string" ||
		typeof entry.sessionFile !== "string" ||
		(entry.status !== "running" &&
			entry.status !== "completed" &&
			entry.status !== "interrupted" &&
			entry.status !== "deleted") ||
		(entry.rlmDepth !== undefined && (!Number.isSafeInteger(entry.rlmDepth) || entry.rlmDepth < 0)) ||
		(entry.rlmMaxDepth !== undefined && (!Number.isSafeInteger(entry.rlmMaxDepth) || entry.rlmMaxDepth < 0))
	)
		return undefined;
	return {
		...entry,
		sessionName: typeof entry.sessionName === "string" ? entry.sessionName : entry.childId,
		sessionDir: typeof entry.sessionDir === "string" ? entry.sessionDir : dirname(entry.sessionFile),
		parentSessionId: typeof entry.parentSessionId === "string" ? entry.parentSessionId : "",
		createdAt: typeof entry.createdAt === "number" ? entry.createdAt : 0,
		updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
	} as PersistedRlmSubagentRegistryEntry;
}

function loadLatest(path: string): { entries: PersistedRlmSubagentRegistryEntry[]; compact: boolean } {
	if (!existsSync(path)) return { entries: [], compact: false };
	const contents = readFileSync(path, "utf8");
	const lines = contents.split(/\r?\n/);
	const latest = new Map<string, PersistedRlmSubagentRegistryEntry>();
	let validRows = 0;
	for (let index = 0; index < lines.length; index++) {
		const trimmed = lines[index]!.trim();
		if (!trimmed) continue;
		let entry: PersistedRlmSubagentRegistryEntry | undefined;
		try {
			entry = parseEntry(trimmed);
		} catch (error) {
			// A process may die midway through the final append in a legacy file.
			if (index === lines.length - 1 && !contents.endsWith("\n")) continue;
			throw new Error(`Malformed RLM subagent registry row ${index + 1}`, { cause: error });
		}
		if (!entry) throw new Error(`Invalid RLM subagent registry row ${index + 1}`);
		validRows++;
		if (entry.status === "deleted") latest.delete(entry.childId);
		else latest.set(entry.childId, entry);
	}
	return { entries: [...latest.values()], compact: validRows !== latest.size || !contents.endsWith("\n") };
}

function writeCompact(path: string, entries: readonly PersistedRlmSubagentRegistryEntry[]): void {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const descriptor = openSync(temporary, "wx", 0o600);
	try {
		const contents = entries.length ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "";
		writeFileSync(descriptor, contents, "utf8");
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	renameSync(temporary, path);
	const directoryDescriptor = openSync(directory, "r");
	try {
		fsyncSync(directoryDescriptor);
	} finally {
		closeSync(directoryDescriptor);
	}
}

export async function readRlmSubagentRegistry(
	path: string,
	options: { compact?: boolean } = {},
): Promise<PersistedRlmSubagentRegistryEntry[]> {
	return withRegistryOwner(path, () => {
		const loaded = loadLatest(path);
		if (options.compact !== false && loaded.compact) writeCompact(path, loaded.entries);
		return loaded.entries;
	});
}

export async function mutateRlmSubagentRegistry<T>(
	path: string,
	mutation: (latest: ReadonlyMap<string, PersistedRlmSubagentRegistryEntry>) => {
		result: T;
		entry?: PersistedRlmSubagentRegistryEntry;
		deleteChildId?: string;
		afterWrite?: () => void;
	},
): Promise<T> {
	return withRegistryOwner(path, () => {
		const loaded = loadLatest(path);
		const latest = new Map(loaded.entries.map((entry) => [entry.childId, entry]));
		const change = mutation(latest);
		if (change.entry) latest.set(change.entry.childId, change.entry);
		if (change.deleteChildId) latest.delete(change.deleteChildId);
		if (loaded.compact || change.entry || change.deleteChildId) writeCompact(path, [...latest.values()]);
		change.afterWrite?.();
		return change.result;
	});
}
