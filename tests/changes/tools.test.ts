import { describe, expect, it } from "bun:test";
import { listFileChangesTool, restoreFileTool } from "../../src/tools/index";

describe("changes tools", () => {
  it("declares write capability and a path argument for restore", () => {
    expect(restoreFileTool.security).toEqual({ caps: [{ fs: "write" }], pathArgs: ["path"] });
    expect(restoreFileTool.alwaysOn).toBe(true);
    expect(listFileChangesTool.security.caps).toEqual([{ fs: "read" }]);
  });

  it("returns a readable message when no session is attached", async () => {
    const ctx = {
      sessionId: undefined, baseDir: process.cwd(), config: {}, logger: {} as never,
    } as never;
    const res = await restoreFileTool.handler(ctx, { path: "a.txt" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("session");
  });
});
