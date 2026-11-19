import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UserProfile } from "../../src/modules/user-profile/profile";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-profile-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("UserProfile: shell и устаревший снимок", () => {
  it("без SHELL пишет shell bash-тула, а не unknown", () => {
    const savedShell = process.env.SHELL;
    delete process.env.SHELL;
    try {
      const profile = new UserProfile(tempDir());
      expect(profile.collect().shell).toBe(process.platform === "win32" ? "cmd" : "sh");
    } finally {
      if (savedShell !== undefined) process.env.SHELL = savedShell;
    }
  });

  it("load() обновляет hostname/shell, сохраняя preferences", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "profile.json"),
      JSON.stringify({
        platform: "linux",
        os: "Linux old-host",
        hostname: "old-host",
        shell: "unknown",
        home: "/root",
        nodeVersion: "v0",
        preferences: { theme: "dark" },
      }),
    );

    const loaded = new UserProfile(dir).load();
    expect(loaded?.hostname).toBe(hostname());
    expect(loaded?.shell).not.toBe("unknown");
    expect(loaded?.preferences).toEqual({ theme: "dark" });
  });
});
