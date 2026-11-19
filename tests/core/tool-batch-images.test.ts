import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ToolBatchExecutor } from "../../src/core/agent/tool-batch";
import { createLoopState } from "../../src/core/agent/loop-state";
import { SessionStore, type SessionLogEntry } from "../../src/modules/session/store";
import { SessionManager } from "../../src/modules/session/manager";
import { SessionLogger } from "../../src/core/session-logger";
import type { ToolEvent } from "../../src/core/types";
import type { ToolResult } from "../../src/tools/types";
import { makeToolBatchDeps } from "../helpers/tool-batch-deps";

const PNG = { bytes: Buffer.from([137, 80, 78, 71]), mime: "image/png" };

function readLogs(baseDir: string, id: string): SessionLogEntry[] {
  const p = join(baseDir, id, "session.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SessionLogEntry);
}

describe("ToolBatchExecutor tool images", () => {
  let tmpDir: string;
  let manager: SessionManager;
  let slog: SessionLogger;
  let sessionId: string;
  let pendingImages: unknown[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-tbi-"));
    const store = new SessionStore(tmpDir);
    store.init();
    manager = new SessionManager(store, { model: "m", contextWindow: 32768, projectDir: "/t" });
    manager.create("s");
    sessionId = manager.getActive()!;
    slog = new SessionLogger(manager);
    pendingImages = [];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function deps(result: ToolResult) {
    const d = makeToolBatchDeps({ execute: () => result });
    d.config.session.autoSave = true;
    d.contextManager.addPendingImage = (part: unknown) => pendingImages.push(part);
    return d;
  }

  async function run(result: ToolResult, logger?: SessionLogger) {
    const events: ToolEvent[] = [];
    const ex = new ToolBatchExecutor(deps(result));
    await ex.execute(
      createLoopState(),
      [{ id: "c1", name: "browser", arguments: { action: "screenshot" } }],
      new Set(),
      "",
      "",
      "task",
      (ev) => events.push(ev),
      (meta, kind) => {},
      logger,
    );
    return events;
  }

  it("persists imageFiles and carries refs in the tool end event", async () => {
    const events = await run({ success: true, output: "shot", imageFiles: [PNG] }, slog);

    const end = events.find((e) => e.type === "end")!;
    expect(end.imageRefs).toHaveLength(1);
    expect(end.imageRefs?.[0].mime).toBe("image/png");
    expect(existsSync(join(tmpDir, sessionId, "images", end.imageRefs![0].file))).toBe(true);
    // data-URL'ы модели не едут в событие, когда есть refs
    expect(end.images).toBeUndefined();
  });

  it("records refs in the tool_result session log", async () => {
    await run({ success: true, output: "shot", imageFiles: [PNG] }, slog);

    const entry = readLogs(tmpDir, sessionId).find((l) => l.type === "tool_result")!;
    expect(entry.images).toHaveLength(1);
    expect(entry.images?.[0].mime).toBe("image/png");
  });

  it("queues model images via queueToolImages regardless of persist", async () => {
    const modelImage = { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } };
    await run(
      { success: true, output: "shot", images: [modelImage] as ToolResult["images"], imageFiles: [PNG] },
      slog,
    );

    expect(pendingImages).toHaveLength(1);
  });

  it("falls back to inline images in the event when nothing was persisted", async () => {
    const modelImage = { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } };
    const events = await run({ success: true, output: "shot", images: [modelImage] as ToolResult["images"] });

    const end = events.find((e) => e.type === "end")!;
    expect(end.imageRefs).toBeUndefined();
    expect(end.images).toHaveLength(1);
  });

  it("emits no image payload for a text-only tool", async () => {
    const events = await run({ success: true, output: "plain" }, slog);

    const end = events.find((e) => e.type === "end")!;
    expect(end.imageRefs).toBeUndefined();
    expect(end.images).toBeUndefined();
  });
});
