/**
 * W10.6: id сессии непредсказуем и не похож на PII.
 *
 * Регресс: 16-hex суффикс мог содержать `\d{10}` (паспорт/ИНН), детектор PII
 * подменял его на `<PII:…>` в ответе `GET /v1/sessions`, и клиент получал id,
 * по которому сессия не находится (404 на следующем запросе).
 */
import { describe, expect, it } from "vitest";
import { detectPii } from "../../src/modules/security/data-policy/detectors/pii/index";
import { newSessionId } from "../../src/modules/session/id";

describe("session ids", () => {
  it("are unpredictable and match the documented shape", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const id = newSessionId();
      expect(id).toMatch(/^ses_[0-9a-z]{8}_[a-z]{16}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(500);
  });

  it("never looks like personal data to the PII detector", () => {
    for (let i = 0; i < 500; i++) {
      expect(detectPii(newSessionId())).toEqual([]);
    }
  });

  it("contains no long digit runs anywhere", () => {
    for (let i = 0; i < 500; i++) expect(newSessionId()).not.toMatch(/\d{10}/);
  });
});
