import { describe, it, expect, vi } from "vitest";
import { queueToolImages } from "../src/core/agent/tool-images";
import type { ImageUrlPart } from "../src/llm/provider";

const img = (id: string): ImageUrlPart => ({
  type: "image_url",
  image_url: { url: `data:image/png;base64,${id}` },
});

describe("queueToolImages", () => {
  it("queues every produced image in order", () => {
    const sink = { addPendingImage: vi.fn() };
    queueToolImages(sink, [img("a"), img("b")]);
    expect(sink.addPendingImage).toHaveBeenCalledTimes(2);
    expect(sink.addPendingImage).toHaveBeenNthCalledWith(1, img("a"));
    expect(sink.addPendingImage).toHaveBeenNthCalledWith(2, img("b"));
  });

  it("is a no-op for undefined or empty images", () => {
    const sink = { addPendingImage: vi.fn() };
    queueToolImages(sink, undefined);
    queueToolImages(sink, []);
    expect(sink.addPendingImage).not.toHaveBeenCalled();
  });

  it("is a no-op when there is no context sink", () => {
    expect(() => queueToolImages(undefined, [img("a")])).not.toThrow();
  });
});
