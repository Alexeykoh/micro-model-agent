import { describe, it, expect, vi } from "vitest";
import { buildDockerRunArgs, runDockerBash, checkSandboxProfile } from "../src/tools/bash-docker";
import type { ToolContext } from "../src/tools/types";

describe("sandbox docker runner (offline)", () => {
  it("builds hardened argv: read-only, no egress, cap-drop, mount only baseDir", () => {
    const args = buildDockerRunArgs({
      image: "oven/bun:1.3.14",
      baseDir: "/proj",
      workdir: "/proj/sub",
      command: "echo hi",
    });
    expect(args).toEqual([
      "run", "--rm",
      "--read-only",
      "--network", "none",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges=true",
      "-u", "1000:1000",
      "-v", "/proj:/work",
      "--workdir", "/work/sub",
      "-e", "HOME=/work",
      "--entrypoint", "bash",
      "oven/bun:1.3.14",
      "-lc", "echo hi",
    ]);
    // Env ключей/провайдеров в argv нет.
    expect(args.join(" ")).not.toContain("APIKEY");
    expect(args.join(" ")).not.toContain("apikey");
  });

  it("local-trusted never treats as sandbox", () => {
    const ctx = { config: { execution: { profile: "local-trusted" } } } as unknown as ToolContext;
    expect(checkSandboxProfile(ctx).ok).toBe(true);
  });

  it("sandbox without docker fails closed", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const res = runDockerBash({
      command: "echo hi",
      workdir: "/proj",
      baseDir: "/proj",
      image: "definitely-no-such-image-xyz",
    });
    return res.then((r) => {
      expect(r.success).toBe(false);
      expect(r.output.length).toBeGreaterThan(0);
    });
  });
});
