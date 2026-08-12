import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("RLM registry sole-writer boundary", () => {
	it("keeps supervisor recovery from calling the catalog registry mutation", () => {
		const source = readFileSync(new URL("../src/modes/daemon/daemon-supervisor.ts", import.meta.url), "utf8");
		expect(source).not.toContain("catalog.markInterrupted");
		expect(source).toContain("pendingRecovery");
	});
	it("keeps the obsolete catalog request fail closed", () => {
		const source = readFileSync(new URL("../src/modes/daemon/daemon-catalog-process.ts", import.meta.url), "utf8");
		expect(source).toContain("Catalog interruption mutation is unsupported");
		expect(source).not.toContain("await reconcileInterruptedRlmChild(request.sessionPath)");
	});
});
