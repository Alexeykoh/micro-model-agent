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

  it("keeps header text readable: a long column absorbs the cut, not the headers", () => {
    // /sessions на 80 колонках: длинное имя сессии сжимало «Обновлено» и
    // «Сообщений» до «Об…»/«Со…». Шапку ниже её собственного текста не режем,
    // пока есть колонка с длинным содержимым.
    const out = formatTable(
      [
        "| ID | Имя | Обновлено | Сообщений |",
        "|---|---|---|---|",
        "| ses_mvm41s8k | Очень длинное имя сессии из первого промпта пользователя | 2026-10-24 10:55:12 | 3 |",
      ],
      { maxWidth: 80 },
    );
    const header = out[0];
    expect(header).toContain("Обновлено");
    expect(header).toContain("Сообщений");
    expect(header).toContain("Имя");
    expect(header).not.toContain("Об…");
    for (const line of out) {
      expect(stringWidth(line)).toBeLessThanOrEqual(80);
    }
  });
});