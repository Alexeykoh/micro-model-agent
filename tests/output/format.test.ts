import { describe, it, expect } from "vitest";
import { formatEventLine } from "../../src/output/format";

const base = {
  id: 1,
  ts: Date.UTC(2026, 8, 18, 5, 59, 52),
  level: "warn" as const,
  source: "module:probe.context",
  kind: "log" as const,
  text: "model supports 262144 tokens",
};

describe("formatEventLine", () => {
  it("renders the legacy log format without color", () => {
    const line = formatEventLine(base, false);
    expect(line).toBe(
      "[WARN] [probe.context] 2026-09-18T05:59:52.000Z — model supports 262144 tokens",
    );
  });

  it("renders the short owner label for module/tool sources", () => {
    expect(formatEventLine({ ...base, source: "tool:bash", level: "info" }, false)).toBe(
      "[INFO] [bash] 2026-09-18T05:59:52.000Z — model supports 262144 tokens",
    );
    expect(formatEventLine({ ...base, source: "core", level: "info" }, false)).toBe(
      "[INFO] [core] 2026-09-18T05:59:52.000Z — model supports 262144 tokens",
    );
  });

  it("forces ANSI color for warn/error/debug regardless of TTY", () => {
    expect(formatEventLine({ ...base, level: "warn" }, true)).toContain("\x1b[33m");
    expect(formatEventLine({ ...base, level: "error" }, true)).toContain("\x1b[31m");
    expect(formatEventLine({ ...base, level: "debug" }, true)).toContain("\x1b[2m");
  });

  it("does not color info even when color is true", () => {
    const line = formatEventLine({ ...base, level: "info" }, true);
    expect(line.includes("\x1b[")).toBe(false);
  });

  it("emits no ANSI for every level when color is false", () => {
    for (const level of ["debug", "info", "warn", "error"] as const) {
      expect(formatEventLine({ ...base, level }, false).includes("\x1b[")).toBe(false);
    }
  });
});
