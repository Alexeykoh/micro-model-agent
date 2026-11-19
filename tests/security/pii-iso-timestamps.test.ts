// Guard: PII-редактор не портит машинные поля ответов API.
//
// Регресс из стресс-теста (волна 14): `/v1/sessions` отдавал
// `"createdAt":"<PII:020cb58fd4ff>T09:12:35.553Z"` — правило `birthdate`
// (`YYYY-MM-DD`) срабатывало на ISO-таймстемпе, и `Date.parse` переставал
// работать у любого клиента. Долг dlp-iso-timestamp-false-positive оплачен:
// дата, за которой идёт `T<время>`, больше не считается датой рождения.
//
// Голая дата вообще не PII: маскируется только дата рядом с меткой рождения
// («дата рождения», «д.р.», born). Иначе ответ пользователю превращался в
// `<PII:…>` на обычных датах («сегодня, 16.11.2026»).
import { describe, it, expect } from "vitest";
import { detectPii } from "../../src/modules/security/data-policy/detectors/pii";
import { DEFAULT_DATA_POLICY } from "../../src/modules/security/data-policy/defaults";
import { projectText } from "../../src/modules/security/data-policy/project";
import { TokenMap } from "../../src/modules/security/data-policy/tokens";

describe("PII: ISO-таймстемпы машинных полей", () => {
  it("машинные поля Job/Session не дают находок PII", () => {
    const payload = JSON.stringify({
      createdAt: "2026-10-28T09:12:35.553Z",
      updatedAt: "2026-10-28T09:14:42.658Z",
      startedAt: "2026-10-28T09:14:11.970Z",
      finishedAt: "2026-10-28T09:14:23.250Z",
      ts: "2026-10-28T09:00:00.000Z",
    });

    expect(detectPii(payload)).toEqual([]);
  });

  it("дата рождения с меткой по-прежнему редактируется", () => {
    expect(detectPii("дата рождения: 1990-05-17").length).toBeGreaterThan(0);
    expect(detectPii("д.р. 17.05.1990").length).toBeGreaterThan(0);
    expect(detectPii("born 05/17/1990").length).toBeGreaterThan(0);
    expect(detectPii("17.05.1990 — дата рождения").length).toBeGreaterThan(0);
  });

  it("дата без метки рождения не считается PII", () => {
    expect(detectPii("## Бенчмарки Qwen4-Max (сегодня, 16.11.2026)")).toEqual([]);
    expect(detectPii('{"name":"Session 2026-10-28"}')).toEqual([]);
    expect(detectPii("Релиз 16.11.2026, обновление вышло")).toEqual([]);
  });

  it("ответ API парсится Date.parse после редакции", () => {
    const payload = JSON.stringify({ createdAt: "2026-10-28T09:12:35.553Z" });
    const findings = detectPii(payload);
    // Ни одна находка не пересекается с таймстемпом.
    const tsStart = payload.indexOf("2026-10-28");
    for (const f of findings) {
      expect(f.start >= tsStart + 10 || f.end <= tsStart).toBe(true);
    }
  });

  it("E2-проекция не маскирует обычную дату в ответе пользователю", () => {
    const text = "## Бенчмарки Qwen4-Max (сегодня, 16.11.2026)";
    const proj = projectText(text, {
      config: DEFAULT_DATA_POLICY,
      target: { kind: "api", trusted: false },
      ctx: { baseDir: "/workspace" },
      map: new TokenMap(),
    });
    expect(proj.text).toBe(text);
    expect(proj.changed).toBe(false);
  });
});
