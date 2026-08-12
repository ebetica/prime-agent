import { describe, expect, it } from "vitest";
import { StaleTranscriptGenerationError } from "../src/core/session-manager.js";
import {
	AtomicResourceReloadRestartRequiredError,
	deserializeDaemonError,
	serializeDaemonError,
} from "../src/modes/daemon/daemon-errors.js";

describe("daemon errors", () => {
	it("round-trips the typed restart-required resource reload error", () => {
		const error = new AtomicResourceReloadRestartRequiredError();
		const errorInfo = serializeDaemonError(error);
		expect(errorInfo).toEqual({ code: "atomic_resource_reload_restart_required" });
		const restored = deserializeDaemonError({
			type: "response",
			command: "reload",
			success: false,
			error: error.message,
			errorInfo,
		});
		expect(restored).toBeInstanceOf(AtomicResourceReloadRestartRequiredError);
		expect(restored.message).toContain("must be restarted");
	});

	it("round-trips stale transcript generation rejection", () => {
		const error = new StaleTranscriptGenerationError();
		const errorInfo = serializeDaemonError(error);
		expect(errorInfo).toEqual({ code: "stale_transcript_generation" });
		const restored = deserializeDaemonError({
			type: "response",
			command: "get_compaction_summary",
			success: false,
			error: error.message,
			errorInfo,
		});
		expect(restored).toBeInstanceOf(StaleTranscriptGenerationError);
	});
});
