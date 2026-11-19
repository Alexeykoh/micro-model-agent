import { describe, it, expect } from "vitest";
import { sanitizeOutput, sanitizeOutputPlain } from "../../src/ui/sanitize-output";
import { stripAnsi } from "../../src/ui/line-math";

/**
 * Вывод тулов/моделей — недоверенный текст: терминальные escape-последовательности,
 * bidi-override и zero-width символы не должны доходить до терминала/веба
 * (аудит §4.12, план `2026-10-12-harness-module-audit-fixes`, W3/Task 3.7).
 */

describe("sanitizeOutput", () => {
  it("strips an OSC 52 clipboard-write sequence", () => {
    expect(sanitizeOutput("\x1b]52;c;aGVsbG8=\x07done")).toBe("done");
  });

  it("strips a DCS/APC sequence terminated by ESC backslash", () => {
    expect(sanitizeOutput("\x1bPpayload\x1b\\after")).toBe("after");
  });

  it("strips bidi overrides and zero-width characters", () => {
    expect(sanitizeOutput("if\u202Ea<b")).toBe("ifa<b");
    expect(sanitizeOutput("a\u200Bb")).toBe("ab");
    expect(sanitizeOutput("a\uFEFFb")).toBe("ab");
  });

  it("strips control characters but keeps tabs and newlines", () => {
    expect(sanitizeOutput("a\x00b\x07c")).toBe("abc");
    expect(sanitizeOutput("a\tb\nc")).toBe("a\tb\nc");
  });

  it("keeps ordinary ANSI colors in the terminal path", () => {
    expect(sanitizeOutput("\x1b[31mred\x1b[0m")).toBe("\x1b[31mred\x1b[0m");
  });

  it("strips ANSI colors for surfaces without a terminal", () => {
    expect(sanitizeOutputPlain("\x1b[31mred\x1b[0m")).toBe("red");
  });
});

describe("stripAnsi", () => {
  it("strips OSC sequences too", () => {
    expect(stripAnsi("\x1b]52;c;aGVsbG8=\x07done")).toBe("done");
  });
});
