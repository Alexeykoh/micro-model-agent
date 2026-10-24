import { describe, it, expect } from "vitest";
import {
  deriveSessionName,
  generateSessionTitle,
  sanitizeTitle,
  TITLE_MAX_TOKENS,
  TITLE_TIMEOUT_MS,
} from "../src/modules/session/auto-name";

describe("deriveSessionName", () => {
  it("uses the first non-empty line", () => {
    expect(deriveSessionName("\n\n  Fix the login bug \n more")).toBe("Fix the login bug");
  });
  it("strips markdown, inline code and urls", () => {
    expect(deriveSessionName("## Add `grep` tool to https://x.io/doc")).toBe("Add tool to");
  });
  it("strips trailing punctuation", () => {
    expect(deriveSessionName("Weather in Paris?")).toBe("Weather in Paris");
  });
  it("caps at word boundary with ellipsis", () => {
    const out = deriveSessionName("a".repeat(10) + " " + "b".repeat(80));
    expect(out.length).toBeLessThanOrEqual(61);
    expect(out.endsWith("…")).toBe(true);
  });
  it("falls back to the date default when nothing remains", () => {
    expect(deriveSessionName("https://only-a-url.example", "2026-09-25")).toBe(
      "Session 2026-09-25",
    );
  });
});

describe("sanitizeTitle", () => {
  it("takes the first line and strips wraps/punctuation", () => {
    expect(sanitizeTitle('"Fix Login Bug."\nextra')).toBe("Fix Login Bug");
  });
  it("returns null for empty output", () => {
    expect(sanitizeTitle("  \n ")).toBeNull();
  });
});

describe("generateSessionTitle", () => {
  it("reports the fail-open reason instead of failing silently", async () => {
    // Ровно боевой случай: бюджет съеден reasoning'ом, `finish_reason=length`,
    // content пустой → заголовка нет, и об этом обязан быть след (INV-15).
    const reasons: string[] = [];
    const title = await generateSessionTitle("Создай файл", async () => "", 1000, (r) =>
      reasons.push(r),
    );
    expect(title).toBeNull();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("empty title");
  });

  it("reports a thrown chat error", async () => {
    const reasons: string[] = [];
    const title = await generateSessionTitle(
      "Создай файл",
      async () => {
        throw new Error("aborted");
      },
      1000,
      (r) => reasons.push(r),
    );
    expect(title).toBeNull();
    expect(reasons).toEqual(["aborted"]);
  });

  it("бюджет заголовка переживает reasoning-токены", () => {
    // 48 не хватало: замер живо — 48 → пусто, 128 → заголовок. Держим запас.
    expect(TITLE_MAX_TOKENS).toBeGreaterThanOrEqual(256);
  });

  it("дефолтный таймаут рассчитан на медленную локальную модель", () => {
    // Ровно боевой случай: локальная 9B отвечает 30–45 с, а старый дефолт 8 с
    // обрывал заголовок (`session title not generated: The operation was aborted`).
    expect(TITLE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });
});
