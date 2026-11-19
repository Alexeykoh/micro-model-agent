import { describe, it, expect } from "vitest";
import { buildBashDescription } from "../../src/tools/bash-description";

describe("bash tool description: platform facts", () => {
  it("does not leak cmd.exe/PowerShell notes to POSIX", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const text = buildBashDescription(platform);
      expect(text).not.toContain("cmd.exe");
      expect(text).not.toContain("PowerShell");
      expect(text).toContain("Execute a shell command");
    }
  });

  it("keeps the Windows notes on win32", () => {
    const text = buildBashDescription("win32");
    expect(text).toContain("cmd.exe");
    expect(text).toContain("PowerShell");
  });
});
