import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../../../src/modules/artifacts/store";

describe("ArtifactStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mma-art-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("sanitizes unsafe names", () => {
    expect(ArtifactStore.sanitizeName("my result!!!")).toBe("my_result");
    expect(ArtifactStore.sanitizeName("../../etc/passwd")).toBe("etc_passwd");
    expect(ArtifactStore.sanitizeName("")).toBe("artifact");
  });

  it("saves and reads content under the session dir", () => {
    const s = new ArtifactStore({ baseDir: dir, sessionId: "ses_1" });
    const abs = s.save("report", "hello world", "md");
    expect(abs).toContain(join(".mma", "artifacts", "ses_1"));
    expect(readFileSync(abs, "utf8")).toBe("hello world");
    expect(s.read("report.md")).toBe("hello world");
    expect(existsSync(abs)).toBe(true);
  });

  it("refuses reads outside the root", () => {
    const s = new ArtifactStore({ baseDir: dir, sessionId: "ses_1" });
    expect(s.read("../../other.md")).toBeNull();
  });

  it("summarizes long content with a truncation marker", () => {
    const s = new ArtifactStore({ baseDir: dir, sessionId: "ses_1" });
    const sum = s.summary("a".repeat(3000), 1000);
    expect(sum.length).toBeLessThan(1100);
    expect(sum).toContain("[truncated: 2000 chars]");
  });
});
