import { describe, it, expect } from "vitest";
import { bootstrap, buildSystemInfo } from "../../src/core/bootstrap";

describe("bootstrap", () => {
	it("creates agent with valid config", async () => {
		const result = await bootstrap("/nonexistent/mma-config", process.cwd());
		expect(result.agent).toBeDefined();
		expect(result.config).toBeDefined();
		expect(result.logger).toBeDefined();
	});

	it("uses defaults when no config found", async () => {
		const result = await bootstrap("/nonexistent/mma-config");
		expect(result.agent).toBeDefined();
		expect(result.config.model).toBe("qwen/qwen3.5-9b");
	});

	it("advertises Bun as the runtime for TypeScript scripts", () => {
		const info = buildSystemInfo(
			{ model: "test-model" } as any,
			"/tmp",
			"win32 shell=cmd",
		);
		expect(info).toContain("Bun is available");
		expect(info).toContain("bun test");
	});
});
