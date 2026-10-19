import { describe, it, expect } from "vitest";
import {
  ibanValid,
  innValid,
  luhnValid,
  ogrnValid,
  snilsValid,
} from "../../src/modules/security/data-policy/detectors/pii/checksums";
import {
  detectByPii,
  detectRfPii,
} from "../../src/modules/security/data-policy/detectors/pii";

describe("PII checksums — РФ", () => {
  it("СНИЛС: валидный/невалидный", () => {
    // 112-233-445 95 — официальный пример ФНС.
    expect(snilsValid("11223344595")).toBe(true);
    expect(snilsValid("11223344596")).toBe(false);
    expect(snilsValid("123")).toBe(false);
  });

  it("ИНН 10/12: контрольная сумма", () => {
    expect(innValid("7707083893")).toBe(true); // Сбербанк
    expect(innValid("7707083894")).toBe(false);
    expect(innValid("500100732259")).toBe(true); // 12-значный официальный пример
    expect(innValid("500100732258")).toBe(false);
  });

  it("ОГРН 13/15: контрольная сумма", () => {
    expect(ogrnValid("1027700132195")).toBe(true);
    expect(ogrnValid("1027700132196")).toBe(false);
    expect(ogrnValid("304500059100380")).toBe(true);
  });

  it("Карты: Luhn и длины", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(luhnValid("1234")).toBe(false);
  });

  it("IBAN: mod-97", () => {
    expect(ibanValid("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(ibanValid("GB82 WEST 1234 5698 7654 33")).toBe(false);
  });
});

describe("PII детекторы — РФ", () => {
  it("ловит телефон РФ и e-mail", () => {
    const r = detectRfPii("звони +7 (912) 345-67-89 или mail@example.com", []);
    const kinds = r.map((f) => f.kind);
    expect(kinds).toContain("ru-phone");
    expect(kinds).toContain("email");
  });

  it("ловит ИНН только при валидной сумме", () => {
    expect(detectRfPii("ИНН 7707083893", []).some((f) => f.kind === "inn")).toBe(true);
    expect(detectRfPii("код 7707083894", []).some((f) => f.kind === "inn")).toBe(false);
  });
});

describe("PII детекторы — РБ", () => {
  it("ловит телефон +375", () => {
    const r = detectByPii("+375 29 123-45-67", []);
    expect(r.some((f) => f.kind === "by-phone")).toBe(true);
  });

  it("УНП — пониженный confidence (без контрольной суммы)", () => {
    const r = detectByPii("УНП 190123456", []);
    const unp = r.find((f) => f.kind === "unp");
    expect(unp).toBeDefined();
    expect(unp!.confidence).toBeLessThan(0.6);
  });
});
