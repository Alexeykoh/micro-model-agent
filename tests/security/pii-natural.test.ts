import { describe, expect, it } from "vitest";
import { classify } from "../../src/modules/security/data-policy/classify";
import type { PolicyContext } from "../../src/modules/security/data-policy/context";

const ctx: PolicyContext = {
  baseDir: "C:\\work\\proj",
  home: "C:\\Users\\alex",
  hostname: "DESKTOP-ABC123",
  username: "alex",
  workspaceRoots: [],
};

function kinds(text: string): string[] {
  return classify(text, ctx).map((f) => f.kind);
}

describe("NER без модели: ФИО и адреса (только уверенные формы)", () => {
  it("ФИО с отчеством ловится", () => {
    expect(kinds("Клиент: Иванов Иван Иванович, договор подписан")).toContain("fio");
    expect(kinds("Петрова Анна Сергеевна")).toContain("fio");
  });

  it("два слова с большой буквы — не ФИО", () => {
    expect(kinds("Hello World")).not.toContain("fio");
    expect(kinds("Иван Иванов пришёл")).not.toContain("fio");
    expect(kinds("const User Name = value")).not.toContain("fio");
  });

  it("адрес с улицей и номером дома ловится", () => {
    expect(kinds("адрес: ул. Ленина, д. 5, кв. 12")).toContain("address");
    expect(kinds("проспект Мира 42")).toContain("address");
    expect(kinds("221B Baker street 12")).toContain("address");
  });

  it("дом без улицы и слово «улица» без номера — не адрес", () => {
    expect(kinds("д. 5 в таблице")).not.toContain("address");
    expect(kinds("Улица — это часть города")).not.toContain("address");
  });

  it("маска ставится на найденный диапазон", () => {
    const text = "Иванов Иван Иванович";
    const hit = classify(text, ctx).find((f) => f.kind === "fio");
    expect(text.slice(hit?.start, hit?.end)).toBe(text);
  });
});
