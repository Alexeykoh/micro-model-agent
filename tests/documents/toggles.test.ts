import { describe, expect, it } from "vitest";
import { buildRegistry } from "../../src/modules/documents/registry";
import { csvHandler } from "../../src/modules/documents/handlers/csv";
import { mdHandler } from "../../src/modules/documents/handlers/md";

describe("вкл/выкл в коде", () => {
  it("отключение группы убирает её обработчики", () => {
    const reg = buildRegistry({ enabled: true, groups: ["spreadsheet"], handlers: [csvHandler, mdHandler] });
    expect(reg.active().handlers).toEqual([]);
  });
  it("DOCUMENTS_ENABLED=false — пустой реестр", () => {
    const reg = buildRegistry({ enabled: false, groups: ["text"], handlers: [csvHandler] });
    expect(reg.active().handlers).toEqual([]);
  });
  it("активная группа оставляет обработчик", () => {
    const reg = buildRegistry({ enabled: true, groups: ["text"], handlers: [csvHandler] });
    expect(reg.active().handlers).toEqual(["csv"]);
  });
});
