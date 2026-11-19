// Guard: короткий ID dev-сборки стабилен и всегда 5 символов (например #a1b2c).
import { describe, it, expect } from "vitest";
import { normalizeBuildId, readDevBuildId } from "../../src/core/version";

describe("идентификатор dev-сборки", () => {
  it("нормализуется до пяти символов", () => {
    expect(normalizeBuildId("a1b2c3d4e")).toBe("a1b2c");
    expect(normalizeBuildId("ABCDEF")).toBe("abcde");
    expect(normalizeBuildId("")).toBe("00000");
    expect(normalizeBuildId("!!")).toBe("00000");
  });

  it("читается детерминированно", () => {
    const first = readDevBuildId();
    expect(first).toMatch(/^[0-9a-f]{5}$/);
    expect(readDevBuildId()).toBe(first);
  });
});
