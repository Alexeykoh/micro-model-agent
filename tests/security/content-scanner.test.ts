import { scanContent } from "../../src/modules/security/content-scanner";
import { describe, it, expect } from "vitest";

describe("Content Scanner", () => {
	describe("scanContent", () => {
		it("should allow safe content when scanning is disabled", () => {
			const config = { enabled: false, dangerousPatterns: [] };
			const result = scanContent("const x = 1;", "test.ts", config);
			expect(result.allowed).toBe(true);
		});

		it("should allow safe content", () => {
			const config = { enabled: true, dangerousPatterns: [] };
			const result = scanContent(
				"const x = 1;\nconsole.log(x);",
				"test.ts",
				config,
			);
			expect(result.allowed).toBe(true);
		});

		it("should block content with eval", () => {
			const config = { enabled: true, dangerousPatterns: [] };
			const result = scanContent('eval("alert(1)")', "test.js", config);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("dangerous patterns");
			expect(result.matches).toContain("eval(");
		});

		it("should block content with child_process.exec", () => {
			const config = { enabled: true, dangerousPatterns: [] };
			const result = scanContent(
				'require("child_process").exec("rm -rf /")',
				"test.js",
				config,
			);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("dangerous patterns");
		});

		it("should block content with rm -rf", () => {
			const config = { enabled: true, dangerousPatterns: [] };
			const result = scanContent("// rm -rf /", "test.js", config);
			expect(result.allowed).toBe(false);
		});

		it("allows legitimate CLI code (process.exit, timers, template literals)", () => {
			const config = { enabled: true, dangerousPatterns: [] };
			const result = scanContent(
				'if (!name) { console.error("usage"); process.exit(1) }\nsetTimeout(() => {}, 100);\nconst msg = `Hello, ${name}!`;\nsetInterval(fn, 1000);',
				"test.ts",
				config,
			);
			expect(result.allowed).toBe(true);
		});

		it("blocks content with process.exit only when explicitly configured", () => {
			const config = {
				enabled: true,
				dangerousPatterns: [/process\.exit\(/gi],
			};
			const result = scanContent("process.exit(1)", "test.js", config);
			expect(result.allowed).toBe(false);
		});

		it("should use custom patterns when provided", () => {
			const customPatterns = [/custom_pattern/gi];
			const config = { enabled: true, dangerousPatterns: customPatterns };
			const result = scanContent(
				"This contains custom_pattern",
				"test.js",
				config,
			);
			expect(result.allowed).toBe(false);
			expect(result.matches).toContain("custom_pattern");
		});

		it("should return all matches", () => {
			const config = { enabled: true, dangerousPatterns: [] };
			const content = 'eval("x"); eval("y");';
			const result = scanContent(content, "test.js", config);
			expect(result.allowed).toBe(false);
			expect(result.matches?.length).toBe(2);
		});
	});
});
