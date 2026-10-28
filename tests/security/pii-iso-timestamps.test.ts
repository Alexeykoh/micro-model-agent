// Guard: PII-редактор не портит машинные поля ответов API.
//
// Регресс из стресс-теста (волна 14): `/v1/sessions` отдавал
// `"createdAt":"<PII:020cb58fd4ff>T09:12:35.553Z"` — правило `birthdate`
// (`YYYY-MM-DD`) срабатывало на ISO-таймстемпе, и `Date.parse` переставал
// работать у любого клиента. Долг dlp-iso-timestamp-false-positive оплачен:
// дата, за которой идёт `T<время>`, больше не считается датой рождения.
import { describe, it, expect } from "vitest";
import { detectPii } from "../../src/modules/security/data-policy/detectors/pii";

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

  it("дата рождения без времени по-прежнему редактируется", () => {
    expect(detectPii("дата рождения: 1990-05-17").length).toBeGreaterThan(0);
    expect(detectPii("д.р. 17.05.1990").length).toBeGreaterThan(0);
  });

  it("дата в имени сессии остаётся под редакцией (осознанно)", () => {
    // Машинных полей тут нет: строка «Session 2026-10-28» — текст, а не ISO.
    expect(detectPii('{"name":"Session 2026-10-28"}').length).toBeGreaterThan(0);
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
});
