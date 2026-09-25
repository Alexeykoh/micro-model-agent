import { describe, it, expect, beforeEach, } from "vitest";
import { ContextManager } from "../src/modules/context/manager";
import type { ContentPart } from "../src/llm/provider";

describe("ContextManager — multimodal content", () => {
  let cm: ContextManager;

  beforeEach(() => {
    cm = new ContextManager(128000);
  });

  it("should accept string content in addMessage", () => {
    cm.addMessage({ role: "user", content: "hello" });
    const history = cm.getActiveHistory();
    expect(history.length).toBe(1);
    expect(history[0].content).toBe("hello");
  });

  it("should accept ContentPart[] in addMessage", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "What's in this image?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
    ];
    cm.addMessage({ role: "user", content: parts });
    const history = cm.getActiveHistory();
    expect(history.length).toBe(1);
    expect(Array.isArray(history[0].content)).toBe(true);
    expect((history[0].content as ContentPart[]).length).toBe(2);
  });

  it("should attach pending images to next user message", () => {
    const imagePart: ContentPart = {
      type: "image_url",
      image_url: { url: "data:image/png;base64,base64data" },
    };
    cm.addPendingImage(imagePart);
    expect(cm.hasPendingImages()).toBe(true);

    cm.addMessage({ role: "user", content: "Describe this" });

    const history = cm.getActiveHistory();
    expect(history.length).toBe(1);
    const content = history[0].content as ContentPart[];
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBe(2);
    expect(content[0]).toEqual({ type: "text", text: "Describe this" });
    expect(content[1]).toEqual(imagePart);

    // Pending images should be cleared after use
    expect(cm.hasPendingImages()).toBe(false);
  });

  it("should not attach pending images to non-user messages", () => {
    cm.addPendingImage({
      type: "image_url",
      image_url: { url: "data:image/png;base64,abc" },
    });

    cm.addMessage({ role: "assistant", content: "response" });

    const history = cm.getActiveHistory();
    // The assistant message should have string content, no image
    expect(typeof history[0].content).toBe("string");
    // Pending images should still be there
    expect(cm.hasPendingImages()).toBe(true);
  });

  it("should handle multiple pending images", () => {
    cm.addPendingImage({
      type: "image_url",
      image_url: { url: "data:image/png;base64,img1" },
    });
    cm.addPendingImage({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,img2" },
    });

    cm.addMessage({ role: "user", content: "Compare these" });

    const history = cm.getActiveHistory();
    const content = history[0].content as ContentPart[];
    expect(content.length).toBe(3); // text + 2 images
    expect(content[0].type).toBe("text");
    expect(content[1].type).toBe("image_url");
    expect(content[2].type).toBe("image_url");
  });

  it("clearPendingImages should remove all pending", () => {
    cm.addPendingImage({
      type: "image_url",
      image_url: { url: "data:image/png;base64,abc" },
    });
    cm.addPendingImage({
      type: "image_url",
      image_url: { url: "data:image/png;base64,def" },
    });
    expect(cm.hasPendingImages()).toBe(true);

    cm.clearPendingImages();
    expect(cm.hasPendingImages()).toBe(false);
    expect(cm.getPendingImages().length).toBe(0);
  });

  it("getPendingImages should return a copy", () => {
    cm.addPendingImage({
      type: "image_url",
      image_url: { url: "data:image/png;base64,abc" },
    });
    const pending = cm.getPendingImages();
    pending.push({ type: "text", text: "mutation test" });
    // Original should not be affected
    expect(cm.getPendingImages().length).toBe(1);
  });

  it("should estimate tokens for multimodal messages", () => {
    const smallImage: ContentPart = {
      type: "image_url",
      image_url: { url: `data:image/png;base64,${"a".repeat(1024)}` },
    };
    cm.addMessage({ role: "user", content: [smallImage] });
    const tokens = cm.getEstimatedTokens();
    // Should be > 0 (image tokens are estimated)
    expect(tokens).toBeGreaterThan(0);
  });

  it("should compact without errors when multimodal messages present", () => {
    cm = new ContextManager(1000);
    cm.addMessage({ role: "system", content: "SYSTEM" });
    for (let i = 0; i < 10; i++) {
      cm.addMessage({ role: "user", content: `msg ${i}` });
      cm.addMessage({ role: "assistant", content: `resp ${i}` });
    }
    // Add a multimodal message
    cm.addPendingImage({
      type: "image_url",
      image_url: { url: "data:image/png;base64,abc" },
    });
    cm.addMessage({ role: "user", content: "with image" });
    cm.addMessage({ role: "assistant", content: "ack" });

    cm.compact();
    const history = cm.getActiveHistory();
    expect(history.length).toBeGreaterThan(0);
  });
});
