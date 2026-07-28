import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  ensureUserDir,
  loadProfile,
  profileExists,
  upsertEntry,
  appendNote,
  collectOS,
  loadProfileSummary,
  initDefaultProfile,
} from "../src/agent/user-profile.js";

const USER_DIR = join(homedir(), ".mma", "user");
const PROFILE_FILE = join(USER_DIR, "profile.md");

function cleanup() {
  try {
    rmSync(USER_DIR, { recursive: true, force: true });
  } catch {}
}

describe("User Profile", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("ensureUserDir creates directory", () => {
    ensureUserDir();
    expect(existsSync(USER_DIR)).toBe(true);
  });

  it("initDefaultProfile creates empty profile", () => {
    initDefaultProfile();
    expect(existsSync(PROFILE_FILE)).toBe(true);
    const content = readFileSync(PROFILE_FILE, "utf-8");
    expect(content).toContain("# User Profile");
  });

  it("initDefaultProfile does not overwrite existing", () => {
    ensureUserDir();
    writeFileSync(PROFILE_FILE, "# Custom Profile\n", "utf-8");
    initDefaultProfile();
    const content = readFileSync(PROFILE_FILE, "utf-8");
    expect(content).toBe("# Custom Profile\n");
  });

  it("loadProfile reads saved content", () => {
    ensureUserDir();
    writeFileSync(
      PROFILE_FILE,
      "# User Profile\n\n## Notes\n- [2026-07-18] test note\n",
      "utf-8",
    );
    const content = loadProfile();
    expect(content).toContain("# User Profile");
    expect(content).toContain("test note");
  });

  it("loadProfile returns empty string for missing file", () => {
    expect(loadProfile()).toBe("");
  });

  it("profileExists returns false when missing", () => {
    expect(profileExists()).toBe(false);
  });

  it("profileExists returns true after init", () => {
    initDefaultProfile();
    expect(profileExists()).toBe(true);
  });

  it("upsertEntry adds to new section", () => {
    initDefaultProfile();
    upsertEntry("Notes", "my note");
    const content = loadProfile();
    expect(content).toContain("## Notes");
    expect(content).toContain("my note");
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}\]/);
  });

  it("upsertEntry updates date for existing entry instead of duplicate", () => {
    initDefaultProfile();
    upsertEntry("Notes", "my note");
    upsertEntry("Notes", "my note");
    const content = loadProfile();
    const matches = content.match(/my note/g);
    expect(matches).toHaveLength(1);
  });

  it("upsertEntry adds multiple unique entries", () => {
    initDefaultProfile();
    upsertEntry("Notes", "first");
    upsertEntry("Notes", "second");
    const content = loadProfile();
    expect(content).toContain("first");
    expect(content).toContain("second");
  });

  it("appendNote adds to Notes section by default", () => {
    initDefaultProfile();
    appendNote("remembered preference");
    const content = loadProfile();
    expect(content).toContain("remembered preference");
  });

  it("collectOS writes OS info", () => {
    initDefaultProfile();
    collectOS();
    const content = loadProfile();
    expect(content).toContain("## OS");
    expect(content).toContain("Platform:");
    expect(content).toContain("Node.js:");
  });

  it("collectOS does not duplicate on second call", () => {
    initDefaultProfile();
    collectOS();
    collectOS();
    const content = loadProfile();
    const headers = content.match(/## OS/g);
    expect(headers).toHaveLength(1);
  });

  it("loadProfileSummary returns formatted summary", () => {
    initDefaultProfile();
    upsertEntry("OS", "Platform: win32");

    const summary = loadProfileSummary();
    expect(summary).toContain("## User Profile");
    expect(summary).toContain("OS");
    expect(summary).not.toContain("Notes");
  });

  it("loadProfileSummary returns empty for empty profile", () => {
    expect(loadProfileSummary()).toBe("");
  });

  it("loadProfileSummary skips Notes section", () => {
    initDefaultProfile();
    upsertEntry("Notes", "secret user preference");
    upsertEntry("OS", "Platform: linux");
    const summary = loadProfileSummary();
    expect(summary).toContain("OS");
    expect(summary).not.toContain("Notes");
    expect(summary).not.toContain("secret");
  });
});
