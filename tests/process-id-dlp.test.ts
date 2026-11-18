// Идентификатор фонового процесса не должен случайно попадать под PII-детектор:
// checksum-правила (OGRN/SNILS/card) принимают часть timestamp за паспорт и
// коверкают id в ответах внешнему клиенту (`proc_скрыто политикой данных…`).
import { describe, it, expect } from "vitest";
import { detectRfPii } from "../src/modules/security/data-policy/detectors/pii/rf";
import { newProcessId } from "../src/modules/processes/registry";

describe("идентификатор процесса и DLP", () => {
  it("не содержит длинных цифровых серий", () => {
    for (let i = 0; i < 300; i += 1) {
      const id = newProcessId(1763000000000 + i * 137);
      expect(id).toMatch(/^proc_[0-9a-z]+_[0-9a-z]+$/);
      expect(id).not.toMatch(/\d{10,}/);
    }
  });

  it("не классифицируется как PII", () => {
    for (let i = 0; i < 300; i += 1) {
      const id = newProcessId(1763000000000 + i * 137);
      expect(detectRfPii(id, [])).toEqual([]);
    }
  });

  it("разные вызовы дают разные id", () => {
    const now = 1763000000000;
    const ids = new Set(Array.from({ length: 10 }, () => newProcessId(now)));
    expect(ids.size).toBe(10);
  });
});
