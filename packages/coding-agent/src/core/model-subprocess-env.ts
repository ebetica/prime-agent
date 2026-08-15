/** Environment boundary for commands and kernels controlled by model output. */
const DAEMON_CONTROL_PREFIX = "PRIME_AGENT_INTERNAL_DAEMON_";

/**
 * Merge explicit child overrides, then remove every daemon control capability.
 * Containment/accounting variables intentionally use different prefixes and
 * remain available to the child.
 */
export function modelSubprocessEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = { ...process.env };
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) delete environment[key];
		else environment[key] = value;
	}
	for (const key of Object.keys(environment)) {
		if (key.startsWith(DAEMON_CONTROL_PREFIX)) delete environment[key];
	}
	return environment;
}
