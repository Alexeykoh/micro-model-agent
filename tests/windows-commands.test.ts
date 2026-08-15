import { describe, it, expect } from "vitest";
import { forbiddenWindowsCommand } from "../src/modules/execution/windows-commands";

describe("forbiddenWindowsCommand", () => {
	it("detects forbidden unix commands", () => {
		expect(forbiddenWindowsCommand("grep -n foo bar")).toBe("grep");
		expect(forbiddenWindowsCommand("cd src && sed -i s/a/b/ f.ts")).toBe("sed");
		expect(forbiddenWindowsCommand("find bicycle-shop -name '*.js'")).toBe("find");
		expect(forbiddenWindowsCommand("ls src")).toBe("ls");
		expect(forbiddenWindowsCommand("rm src/a.js")).toBe("rm");
	});

	it("allows native windows commands and tools", () => {
		expect(forbiddenWindowsCommand("type foo.txt")).toBeNull();
		expect(forbiddenWindowsCommand("dir /b src")).toBeNull();
		expect(forbiddenWindowsCommand("bun test")).toBeNull();
		expect(forbiddenWindowsCommand("npm run build")).toBeNull();
		expect(forbiddenWindowsCommand("del src\\a.js")).toBeNull();
	});
});
