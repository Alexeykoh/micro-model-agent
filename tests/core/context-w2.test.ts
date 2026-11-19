/**
 * W2: контекст и компакция — evidence привязан к ходу, картинки считаются по
 * пикселям и ограничены, hard-drop собирает сводку из выброшенного head,
 * несжимаемый overflow не повторяется, а перегрузка окна видна явно.
 */
import { describe, expect, it } from "vitest";
import { ContextManager } from "../../src/core/context/manager";
import { createLoopState } from "../../src/core/agent/loop-state";
import { lastToolEvidence } from "../../src/core/agent/hallucination-claims";
import { imageTokenCost, imageTokensForDataUrl } from "../../src/llm/image-utils";
import { MAX_QUEUED_TOOL_IMAGES, imageContentKey } from "../../src/core/agent/tool-images";

/** Минимальный data URL с PNG-заголовком нужного размера. */
function pngDataUrl(width: number, height: number): string {
  const header = Buffer.alloc(24);
  header[0] = 0x89;
  header[1] = 0x50;
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return `data:image/png;base64,${header.toString("base64")}`;
}

describe("evidence scope", () => {
  it("only sees tool results of the current turn", () => {
    const cm = new ContextManager(32768);
    cm.addMessage({ role: "user", content: "task" });
    cm.addMessage({ role: "tool", name: "write_file", content: "saved", success: true });
    const mark = cm.beginTurn();
    cm.addMessage({ role: "user", content: "next question" });

    const state = createLoopState();
    state.criticHistoryMark = mark;
    const evidence = lastToolEvidence({
      state,
      contextManager: cm,
    } as never);

    expect(evidence).toEqual([]);
  });

  it("sees tool results of the current turn", () => {
    const cm = new ContextManager(32768);
    cm.addMessage({ role: "user", content: "task" });
    const mark = cm.beginTurn();
    cm.addMessage({ role: "tool", name: "write_file", content: "saved", success: true });

    const state = createLoopState();
    state.criticHistoryMark = mark;
    const evidence = lastToolEvidence({ state, contextManager: cm } as never);

    expect(evidence).toHaveLength(1);
    expect(evidence[0].name).toBe("write_file");
  });
});

describe("image tokens", () => {
  it("scores by tile count, not by base64 length", () => {
    const small = imageTokenCost(800, 800);
    const large = imageTokenCost(1600, 1600);
    expect(small).toBeLessThan(large);
    expect(large).toBeLessThan(3000);
  });

  it("reads png dimensions from the data url", () => {
    expect(imageTokensForDataUrl(pngDataUrl(800, 600))).toBe(
      imageTokenCost(800, 600),
    );
  });
});

describe("pending image queue", () => {
  it("caps the queue and dedups by content", () => {
    const cm = new ContextManager(32768);
    const image = { type: "image_url" as const, image_url: { url: pngDataUrl(10, 10) } };
    for (let i = 0; i < MAX_QUEUED_TOOL_IMAGES + 3; i++) {
      cm.addPendingImage({
        type: "image_url",
        image_url: { url: `${image.image_url.url}#${i}` },
      });
    }
    expect(cm.getPendingImages()).toHaveLength(MAX_QUEUED_TOOL_IMAGES);

    const before = cm.getPendingImages().length;
    cm.addPendingImage(image);
    cm.addPendingImage(image);
    // Очередь полна — новый кадр вытесняет старый, дубль не добавляется.
    expect(cm.getPendingImages().length).toBe(before);
    expect(cm.getPendingImages().filter((p) => imageContentKey(p) === imageContentKey(image))).toHaveLength(1);
  });

  it("does not leak pending images into the next turn", () => {
    const cm = new ContextManager(32768);
    cm.addPendingImage({ type: "image_url", image_url: { url: pngDataUrl(10, 10) } });
    expect(cm.hasPendingImages()).toBe(true);
    cm.clear();
    expect(cm.hasPendingImages()).toBe(false);
  });
});

describe("hard-drop summary", () => {
  it("builds the summary from the dropped head, not the previous compaction", () => {
    const cm = new ContextManager(32768);
    cm.addMessage({ role: "system", content: "sys" });
    for (let i = 0; i < 30; i++) {
      cm.addMessage({ role: "user", content: `step ${i} `.repeat(400) });
      cm.addMessage({ role: "assistant", content: `done ${i} `.repeat(400) });
    }
    // Первая компакция задаёт compactedBlock; дальше hard-drop не должен
    // переиспользовать его как сводку выброшенного head.
    cm.compact();
    const result = cm.compactAdaptive({ toolResultKeep: 6, minReduction: 0 });
    expect(result).toBeTruthy();
    const texts = cm
      .getActiveHistory()
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(texts).toContain("Compressed:");
  });
});

describe("overcommitted", () => {
  it("flags a context that does not fit the window", () => {
    const cm = new ContextManager(1000);
    cm.addMessage({ role: "system", content: "sys" });
    cm.addMessage({ role: "user", content: "x".repeat(8000) });
    const breakdown = cm.getBreakdown();
    expect(breakdown.overcommitted).toBe(true);
  });

  it("is false for a context that fits", () => {
    const cm = new ContextManager(32768);
    cm.addMessage({ role: "user", content: "short" });
    expect(cm.getBreakdown().overcommitted).toBe(false);
  });
});
