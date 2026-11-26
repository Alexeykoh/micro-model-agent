import { describe, expect, it } from "vitest";
import { byIdValid, unpValid } from "../../src/modules/security/data-policy/detectors/pii/checksums";
import { detectByPii } from "../../src/modules/security/data-policy/detectors/pii/by";

describe("белорусские контрольные суммы", () => {
  it("УНП: официальные векторы МНС №127", () => {
    // 2×29 + 9×17 + 8×13 + 8×7 + 5×5 + 4×3 = 408; 408 mod 11 = 1.
    expect(unpValid("200988541")).toBe(true);
    // М∧1953684: 22×29 + 1×19 + 9×17 + 5×13 + 3×7 + 6×5 + 8×3 = 950; mod 11 = 4.
    expect(unpValid("МА1953684")).toBe(true);
    expect(unpValid("MA1953684")).toBe(true);
    expect(unpValid("200988542")).toBe(false);
    expect(unpValid("123456789")).toBe(false);
    expect(unpValid("20098854")).toBe(false);
  });

  it("личный номер: схема МВД №345 (веса 731, letters A..Z = 10..35)", () => {
    expect(byIdValid("7000000A123PB5")).toBe(true);
    expect(byIdValid("7000000A123PB6")).toBe(false);
    expect(byIdValid("7000000A123PB")).toBe(false);
  });

  it("детектор повышает confidence только при верной контрольной сумме", () => {
    const valid = detectByPii("УНП 200988541 и 7000000A123PB5", []);
    expect(valid.find((f) => f.kind === "unp")?.confidence).toBeGreaterThan(0.4);
    expect(valid.find((f) => f.kind === "by-id")?.confidence).toBeGreaterThan(0.5);

    const invalid = detectByPii("УНП 200988542 и 7000000A123PB6", []);
    expect(invalid.find((f) => f.kind === "unp")?.confidence).toBeLessThan(0.4);
    expect(invalid.find((f) => f.kind === "by-id")?.confidence).toBeLessThan(0.5);
  });
});
