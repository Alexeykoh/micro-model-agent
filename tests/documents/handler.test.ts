import { describe, expect, it } from "vitest";
import { detectHead } from "../../src/modules/documents/handler";

describe("DocumentHandler", () => {
  it("detectHead распознаёт ZIP и PDF по magic-bytes", () => {
    expect(detectHead(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe("zip");
    expect(detectHead(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe("pdf");
    expect(detectHead(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBe("svg");
    expect(detectHead(new Uint8Array([0x68, 0x69]))).toBe("unknown");
  });
});
