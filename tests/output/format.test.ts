import { describe, it, expect } from "vitest";
import { formatEventLine } from "../../src/output/format";

const base = {
  id: 1,
  ts: Date.UTC(2026, 8, 18, 5, 59, 52),
  level: "warn" as const,
  source: "probe.context",
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

  it("omits the source bracket when empty", () => {
    const line = formatEventLine({ ...base, source: "", level: "info" }, false);
    expect(line.startsWith("[INFO] 2026-")).toBe(true);
  });
});
