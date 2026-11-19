import { describe, it, expect } from "vitest";
import { matchProtectedPath, protectedPathBlock } from "../../src/modules/security/protected-paths";

describe("matchProtectedPath", () => {
  const base = "/work";

  it("matches VCS internals", () => {
    expect(matchProtectedPath(base, "/work/.git/config")).toBe(".git/");
    expect(matchProtectedPath(base, "/work/.git")).toBe(".git/");
    expect(matchProtectedPath(base, "/work/sub/.hg/hgrc")).toBe(".hg/");
  });

  it("matches env and secret files", () => {
    expect(matchProtectedPath(base, "/work/.env")).toBe(".env");
    expect(matchProtectedPath(base, "/work/.env.local")).toBe(".env.*");
    expect(matchProtectedPath(base, "/work/certs/server.key")).toBe("*.key");
    expect(matchProtectedPath(base, "/work/id_rsa.pem")).toBe("*.pem");
    expect(matchProtectedPath(base, "/work/.npmrc")).toBe(".npmrc");
    expect(matchProtectedPath(base, "/work/.git-credentials")).toBe(".git-credentials");
  });

  it("does not match ordinary files", () => {
    expect(matchProtectedPath(base, "/work/src/index.ts")).toBeUndefined();
    expect(matchProtectedPath(base, "/work/environment.ts")).toBeUndefined();
    expect(matchProtectedPath(base, "/work/docs/env.md")).toBeUndefined();
    expect(matchProtectedPath(base, "/work/keyboard.json")).toBeUndefined();
  });
});

describe("protectedPathBlock", () => {
  const ctx = { baseDir: "/work", sessionId: "ses_x" };

  it("returns a refusal telling the model to ask the user", () => {
    const block = protectedPathBlock(ctx, "/work/.git/config", ".git/config", "file_delete");
    expect(block).toBeDefined();
    expect(block!.success).toBe(false);
    expect(block!.output).toContain("Protected path");
    expect(block!.output).toContain("Ask the user");
  });

  it("returns undefined for ordinary paths", () => {
    expect(protectedPathBlock(ctx, "/work/src/a.ts", "src/a.ts")).toBeUndefined();
  });
});
