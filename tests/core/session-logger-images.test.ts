import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionStore, type SessionLogEntry } from "../../src/modules/session/store";
import { SessionManager } from "../../src/modules/session/manager";
import { SessionLogger } from "../../src/core/session-logger";

const LIMITS = { maxCount: 30, maxBytes: 104_857_600 };
const PNG = { bytes: Buffer.from([137, 80, 78, 71]), mime: "image/png" };

function makeManager(tmpDir: string, encryption?: { enabled: boolean; encryptHistory: boolean; encryptSessionLog: boolean; keyPath?: string }): SessionManager {
  const store = new SessionStore(tmpDir, encryption);
  store.init();
  return new SessionManager(store, {
    model: "m",
    contextWindow: 32768,
    projectDir: "/test",
  });
}

function readLogs(baseDir: string, id: string): SessionLogEntry[] {
  const p = join(baseDir, id, "session.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SessionLogEntry);
}

describe("SessionLogger tool images", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-sli-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists assets into <sessionDir>/images and returns refs", () => {
    const manager = makeManager(tmpDir);
    manager.create("s");
    const id = manager.getActive()!;
    const slog = new SessionLogger(manager);

    const refs = slog.persistToolImages([PNG], LIMITS);

    expect(refs).toHaveLength(1);
    expect(refs[0].mime).toBe("image/png");
    expect(refs[0].bytes).toBe(4);
    expect(existsSync(join(tmpDir, id, "images", refs[0].file))).toBe(true);
  });

  it("records refs in the tool_result log entry", () => {
    const manager = makeManager(tmpDir);
    manager.create("s");
    const id = manager.getActive()!;
    const slog = new SessionLogger(manager);

    const refs = slog.persistToolImages([PNG], LIMITS);
    slog.logToolResult(
      { id: "c1", name: "browser", arguments: { action: "screenshot" } },
      { success: true, output: "ok" },
      10,
      0,
      refs,
    );

    const entry = readLogs(tmpDir, id).find((l) => l.type === "tool_result")!;
    expect(entry.images).toEqual(refs);
    expect(entry.images?.[0].file).toMatch(/\.png$/);
  });

  it("omits images field when no refs", () => {
    const manager = makeManager(tmpDir);
    manager.create("s");
    const id = manager.getActive()!;
    const slog = new SessionLogger(manager);

    slog.logToolResult({ id: "c1", name: "bash", arguments: {} }, { success: true, output: "ok" }, 10, 0);

    const entry = readLogs(tmpDir, id).find((l) => l.type === "tool_result")!;
    expect(entry.images).toBeUndefined();
  });

  it("returns [] without an active session", () => {
    const manager = makeManager(tmpDir);
    const slog = new SessionLogger(manager);
    expect(slog.persistToolImages([PNG], LIMITS)).toEqual([]);
    expect(new SessionLogger(undefined).persistToolImages([PNG], LIMITS)).toEqual([]);
  });

  it("skips persistence when session encryption is enabled", () => {
    const manager = makeManager(tmpDir, {
      enabled: true,
      encryptHistory: true,
      encryptSessionLog: true,
      keyPath: join(tmpDir, ".session-key"),
    });
    manager.create("s");
    const id = manager.getActive()!;
    const slog = new SessionLogger(manager);

    const refs = slog.persistToolImages([PNG], LIMITS);

    expect(refs).toEqual([]);
    expect(existsSync(join(tmpDir, id, "images"))).toBe(false);
  });

  it("applies rotation limits", () => {
    const manager = makeManager(tmpDir);
    manager.create("s");
    const slog = new SessionLogger(manager);

    const refs = slog.persistToolImages([PNG, PNG, PNG], { maxCount: 1, maxBytes: 1_000_000 });
    expect(refs).toHaveLength(3);

    const id = manager.getActive()!;
    const files = readdirSync(join(tmpDir, id, "images"));
    expect(files.length).toBe(1);
  });
});

describe("SessionLogger user images", () => {
  let tmpDir: string;

  const dataUrl = (): string => "data:image/png;base64," + Buffer.from([137, 80, 78, 71]).toString("base64");

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-sli-user-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists user data-URL images and records refs on the user entry", () => {
    const manager = makeManager(tmpDir);
    manager.create("s");
    const id = manager.getActive()!;
    const slog = new SessionLogger(manager);

    const refs = slog.persistUserImages([dataUrl()], LIMITS);
    expect(refs).toHaveLength(1);
    expect(refs[0].mime).toBe("image/png");
    expect(existsSync(join(tmpDir, id, "images", refs[0].file))).toBe(true);

    slog.logUser("что на картинке?", refs);
    const entry = readLogs(tmpDir, id).find((l) => l.type === "user")!;
    expect(entry.content).toBe("что на картинке?");
    expect(entry.images).toEqual(refs);
  });

  it("omits images field when user had no attachments", () => {
    const manager = makeManager(tmpDir);
    manager.create("s");
    const id = manager.getActive()!;
    const slog = new SessionLogger(manager);

    slog.logUser("plain");
    const entry = readLogs(tmpDir, id).find((l) => l.type === "user")!;
    expect(entry.images).toBeUndefined();
  });

  it("skips non-data URLs and empty input", () => {
    const manager = makeManager(tmpDir);
    manager.create("s");
    const slog = new SessionLogger(manager);
    expect(slog.persistUserImages(["https://example.com/a.png"], LIMITS)).toEqual([]);
    expect(slog.persistUserImages([], LIMITS)).toEqual([]);
    expect(slog.persistUserImages(undefined, LIMITS)).toEqual([]);
  });

  it("skips persistence when session encryption is enabled", () => {
    const manager = makeManager(tmpDir, {
      enabled: true,
      encryptHistory: true,
      encryptSessionLog: true,
      keyPath: join(tmpDir, ".session-key"),
    });
    manager.create("s");
    const slog = new SessionLogger(manager);
    expect(slog.persistUserImages([dataUrl()], LIMITS)).toEqual([]);
  });
});
