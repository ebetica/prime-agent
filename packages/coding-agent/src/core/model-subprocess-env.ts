/** Environment boundary for commands and kernels controlled by model output. */
const INTERNAL_PREFIX = "PRIME_AGENT_INTERNAL_";
const ACCOUNTING_ENV = [
	"PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL",
	"PRIME_AGENT_INTERNAL_SESSION_LEASES",
	"PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID",
] as const;

/**
 * Merge explicit child overrides, remove every internal host value, then restore
 * only non-authority accounting state from the trusted host environment.
 */
export function modelSubprocessEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const trustedAccounting = Object.fromEntries(ACCOUNTING_ENV.map((key) => [key, process.env[key]]));
	const environment: NodeJS.ProcessEnv = { ...process.env };
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) delete environment[key];
		else environment[key] = value;
	}
	for (const key of Object.keys(environment)) {
		if (key.startsWith(INTERNAL_PREFIX)) delete environment[key];
	}
	for (const [key, value] of Object.entries(trustedAccounting)) {
		if (value !== undefined) environment[key] = value;
	}
	return environment;
}
