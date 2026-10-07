import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeDataUrl,
  saveToolImage,
  pruneToolImages,
  readToolImage,
  isSafeImageName,
} from "../../src/modules/session/image-store";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "img-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("image-store", () => {
  it("decodes a data URL to bytes + mime", () => {
    const { bytes, mime } = decodeDataUrl("data:image/png;base64,AQID");
    expect(mime).toBe("image/png");
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it("saves and reads back", () => {
    const ref = saveToolImage(
      dir,
      { bytes: Buffer.from([1, 2, 3]), mime: "image/png" },
      { maxCount: 30, maxBytes: 1e9 },
    );
    expect(isSafeImageName(ref.file)).toBe(true);
    const got = readToolImage(dir, ref.file);
    expect(got && [...got.bytes]).toEqual([1, 2, 3]);
    expect(got?.mime).toBe("image/png");
  });

  it("prunes oldest by count", () => {
    for (let i = 0; i < 5; i++) {
      saveToolImage(dir, { bytes: Buffer.from([i]), mime: "image/png" }, {
        maxCount: 2,
        maxBytes: 1e9,
      });
    }
    expect(readdirSync(join(dir, "images")).length).toBe(2);
  });

  it("prunes by total bytes", () => {
    const big = Buffer.alloc(10);
    for (let i = 0; i < 3; i++) {
      saveToolImage(dir, { bytes: big, mime: "image/png" }, { maxCount: 100, maxBytes: 15 });
    }
    expect(readdirSync(join(dir, "images")).length).toBe(1);
  });

  it("rejects traversal names", () => {
    expect(isSafeImageName("../secret")).toBe(false);
    expect(isSafeImageName("a/b.png")).toBe(false);
    expect(readToolImage(dir, "../x.png")).toBeNull();
  });

  it("prune is a no-op without a directory", () => {
    expect(() => pruneToolImages(join(dir, "nope"), { maxCount: 1, maxBytes: 1 })).not.toThrow();
  });
});
