import { describe, it, expect } from "vitest";
import { formatTable } from "../../src/ui/table";
import stringWidth from "string-width";

/**
 * Таблицы влезают в ширину терминала: колонки ужимаются, последняя колонка
 * переносится по словам, лишние колонки отбрасываются с пометкой (аудит §8.14,
 * план `2026-10-12-harness-module-audit-fixes`, W9/Task 9.4).
 */

describe("таблица: вписывается в терминал", () => {
  it("never renders a row wider than the terminal", () => {
    const rows = ["| a | b | c |", "|---|---|---|"];
    for (let i = 0; i < 20; i++) {
      rows.push(`| cell-${i}-very-long-value | another-long-cell | third |`);
    }
    const out = formatTable(rows, { maxWidth: 60 });
    for (const line of out) {
      expect(stringWidth(line)).toBeLessThanOrEqual(60);
    }
  });

  it("wraps the last column instead of overflowing the screen", () => {
    const out = formatTable(
      ["| name | description |", "|---|---|", "| a | very long description text that cannot fit |"],
      { maxWidth: 24 },
    );
    for (const line of out) {
      expect(stringWidth(line)).toBeLessThanOrEqual(24);
    }
    expect(out.join("\n")).toContain("very long");
  });

  it("drops the extra columns and says how many", () => {
    const header = `| ${Array.from({ length: 10 }, (_, i) => `c${i}`).join(" | ")} |`;
    const sep = `|${Array.from({ length: 10 }, () => "---").join("|")}|`;
    const out = formatTable([header, sep], { maxWidth: 120 });
    expect(out.join("\n")).toContain("more columns");
  });
});