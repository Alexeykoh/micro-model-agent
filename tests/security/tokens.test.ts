import { describe, it, expect } from "vitest";
import { TokenMap, rehydrate, rehydrateArgs } from "../../src/modules/security/data-policy/tokens";

describe("TokenMap псевдонимизация", () => {
  it("токен неперебираем (hex ≥ 8) и содержит метку класса", () => {
    const map = new TokenMap();
    const t = map.tokenFor("C:\\work\\secret.txt", "path");
    expect(t).toMatch(/^<PATH:[0-9a-f]{8,}>$/);
  });

  it("идемпотентность: одно значение → один токен", () => {
    const map = new TokenMap();
    const a = map.tokenFor("host.local", "machine");
    const b = map.tokenFor("host.local", "machine");
    expect(a).toBe(b);
    expect(map.size).toBe(1);
  });

  it("разные значения → разные токены (ненумерованные)", () => {
    const map = new TokenMap();
    const a = map.tokenFor("/a", "path");
    const b = map.tokenFor("/b", "path");
    expect(a).not.toBe(b);
  });

  it("ре-гидратация возвращает оригинал", () => {
    const map = new TokenMap();
    const t = map.tokenFor("C:\\work\\app", "path");
    expect(rehydrate(`read ${t}\\src\\index.ts`, map)).toBe("read C:\\work\\app\\src\\index.ts");
  });

  it("чужой/неизвестный токен не подставляется (INV-D5)", () => {
    const map = new TokenMap();
    map.tokenFor("my-value", "pii");
    const foreign = "<PATH:deadbeefdeadbeef>";
    expect(rehydrateArgs(`open ${foreign}`, map)).toBe(`open ${foreign}`);
  });

  it("без карты текст не меняется", () => {
    expect(rehydrate("<PATH:deadbeef>", undefined)).toBe("<PATH:deadbeef>");
  });
});
