import { describe, expect, it } from "vitest";
import { emptyIR, type DocumentIR } from "../../src/modules/documents/ir";

describe("DocumentIR", () => {
  it("emptyIR несёт формат и нулевые блоки", () => {
    const ir: DocumentIR = emptyIR("txt", 12);
    expect(ir.meta.format).toBe("txt");
    expect(ir.meta.bytes).toBe(12);
    expect(ir.outline).toEqual([]);
    expect(ir.blocks).toEqual([]);
  });
});
