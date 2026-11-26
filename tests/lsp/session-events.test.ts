import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionLogger } from "../../src/core/session-logger";
import { SessionManager } from "../../src/modules/session/manager";
import { SessionStore } from "../../src/modules/session/store";
import { LspModule } from "../../src/modules/lsp/module";

describe("LSP lifecycle events in session.jsonl", () => {
  let dir: string;
  let store: SessionStore;
  let manager: SessionManager;
  let sessionId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mma-lsp-slog-"));
    store = new SessionStore(dir);
    store.init();
    manager = new SessionManager(store, {
      model: "qwen/qwen3.5-9b",
      contextWindow: 32768,
      projectDir: dir,
    });
    manager.create("s");
    sessionId = manager.getActive()!;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function readLogs() {
    const path = join(dir, sessionId, "session.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  it("writes phase and duration into session.jsonl through the sink", () => {
    const slog = new SessionLogger(manager);
    const lsp = new LspModule({ enabled: true }, undefined, undefined, dir);
    lsp.setSessionSink((op, msg, meta) => slog.logLsp(op, msg, meta));

    lsp.emit("check", "LSP check failed", { durMs: 234, server: "ts" });

    const event = readLogs().find((entry) => entry.type === "lsp");
    expect(event).toMatchObject({
      module: "lsp",
      source: "core",
      op: "check",
      content: "LSP check failed",
      duration: 234,
    });
  });

  it("without a sink the module does not touch session.jsonl", () => {
    const lsp = new LspModule({ enabled: true }, undefined, undefined, dir);
    lsp.emit("warm_start", "warming", { durMs: 10 });
    expect(readLogs().some((entry) => entry.type === "lsp")).toBe(false);
  });
});
