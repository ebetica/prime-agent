import { SessionReloadBusyError } from "../../core/agent-session.js";
import { MissingSessionCwdError } from "../../core/session-cwd.js";
import { SessionImportFileNotFoundError } from "../../core/session-import-errors.js";
import { SessionAlreadyActiveError } from "../../core/session-lease.js";
import type { DaemonErrorInfo, DaemonResponse } from "./daemon-protocol.js";

export class AtomicResourceReloadRestartRequiredError extends Error {
	readonly code = "atomic_resource_reload_restart_required" as const;

	constructor() {
		super("The resident session worker must be restarted before atomic resource reloads are available");
		this.name = "AtomicResourceReloadRestartRequiredError";
	}
}

export function serializeDaemonError(error: unknown): DaemonErrorInfo | undefined {
	if (error instanceof AtomicResourceReloadRestartRequiredError) {
		return { code: "atomic_resource_reload_restart_required" };
	}
	if (error instanceof SessionReloadBusyError) {
		return { code: "session_reload_busy" };
	}
	if (error instanceof MissingSessionCwdError) {
		return { code: "missing_session_cwd", issue: error.issue };
	}
	if (error instanceof SessionImportFileNotFoundError) {
		return { code: "session_import_file_not_found", filePath: error.filePath };
	}
	if (error instanceof SessionAlreadyActiveError) {
		return {
			code: "session_already_active",
			sessionPath: error.sessionPath,
			activeSessionId: error.activeSessionId,
		};
	}
	return undefined;
}

export function deserializeDaemonError(response: Extract<DaemonResponse, { success: false }>): Error {
	const { errorInfo } = response;
	if (errorInfo?.code === "atomic_resource_reload_restart_required") {
		return new AtomicResourceReloadRestartRequiredError();
	}
	if (errorInfo?.code === "session_reload_busy") {
		return new SessionReloadBusyError();
	}
	if (errorInfo?.code === "missing_session_cwd") {
		return new MissingSessionCwdError(errorInfo.issue);
	}
	if (errorInfo?.code === "session_import_file_not_found") {
		return new SessionImportFileNotFoundError(errorInfo.filePath);
	}
	if (errorInfo?.code === "session_already_active") {
		return new SessionAlreadyActiveError(errorInfo.sessionPath, errorInfo.activeSessionId);
	}
	return new Error(response.error);
}
