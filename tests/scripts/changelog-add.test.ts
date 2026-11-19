// Гвард `scripts/changelog-add.ts`: новая запись вставляется в `## [Unreleased]`
// и не трогает остальной файл (он весит сотни килобайт, переписывать его нельзя).
import { describe, expect, it } from "vitest";
import {
  appendChangelogEntry,
  canonicalSection,
  formatEntry,
} from "../../scripts/changelog-add.ts";

const SAMPLE = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- первая",
  "",
  "### Fixed",
  "",
  "- старая",
  "",
  "## [0.24.4] - 2026-11-06",
  "",
  "### Fixed",
  "",
  "- релизная",
  "",
].join("\r\n");

describe("appendChangelogEntry", () => {
  it("вставляет пункт первым в существующую подсекцию (свежее сверху)", () => {
    const { text, changed } = appendChangelogEntry(SAMPLE, "Fixed", "новая");

    expect(changed).toBe(true);
    expect(text).toBe(
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "### Added",
        "",
        "- первая",
        "",
        "### Fixed",
        "",
        "- новая",
        "- старая",
        "",
        "## [0.24.4] - 2026-11-06",
        "",
        "### Fixed",
        "",
        "- релизная",
        "",
      ].join("\r\n"),
    );
  });

  it("создаёт отсутствующую подсекцию в каноническом порядке", () => {
    const { text } = appendChangelogEntry(SAMPLE, "Changed", "новая");

    expect(text).toBe(
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "### Added",
        "",
        "- первая",
        "",
        "### Changed",
        "",
        "- новая",
        "",
        "### Fixed",
        "",
        "- старая",
        "",
        "## [0.24.4] - 2026-11-06",
        "",
        "### Fixed",
        "",
        "- релизная",
        "",
      ].join("\r\n"),
    );
  });

  it("сохраняет CRLF и не добавляет одиночных LF", () => {
    const { text } = appendChangelogEntry(SAMPLE, "Added", "вторая");

    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("не дублирует уже существующую запись", () => {
    const once = appendChangelogEntry(SAMPLE, "Fixed", "новая");
    const twice = appendChangelogEntry(once.text, "Fixed", "новая");

    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once.text);
  });

  it("оформляет многострочную запись с отступом продолжения", () => {
    const { text } = appendChangelogEntry(SAMPLE, "Fixed", "заголовок\nвторая строка");

    expect(text).toContain("- заголовок\r\n  вторая строка\r\n");
  });

  it("дописывает, когда после Unreleased нет релизов", () => {
    const source = "# Changelog\r\n\r\n## [Unreleased]\r\n\r\n### Added\r\n\r\n- первая\r\n";
    const { text } = appendChangelogEntry(source, "Added", "вторая");

    expect(text).toBe(
      "# Changelog\r\n\r\n## [Unreleased]\r\n\r\n### Added\r\n\r\n- вторая\r\n- первая\r\n",
    );
  });

  it("падает без секции Unreleased вместо тихой записи в чужое место", () => {
    expect(() => appendChangelogEntry("## [0.1.0] - 2026-01-01\r\n", "Fixed", "x")).toThrow(
      /Unreleased/,
    );
  });
});

describe("formatEntry", () => {
  it("снимает пользовательский маркер списка", () => {
    expect(formatEntry("- пункт")).toEqual(["- пункт"]);
  });

  it("отклоняет пустую запись", () => {
    expect(() => formatEntry("  \n ")).toThrow(/empty/);
  });
});

describe("canonicalSection", () => {
  it("нормализует регистр известной секции", () => {
    expect(canonicalSection("fixed")).toBe("Fixed");
  });

  it("оставляет незнакомую секцию как есть", () => {
    expect(canonicalSection("Notes")).toBe("Notes");
  });
});
