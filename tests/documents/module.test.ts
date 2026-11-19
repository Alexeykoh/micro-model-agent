import { describe, expect, it } from "vitest";
import { documentsModuleDef } from "../../src/modules/documents/module";

describe("documentsModuleDef", () => {
  it("не критичен, объявляет четыре тула, без configKeys", () => {
    const def = documentsModuleDef();
    expect(def.name).toBe("documents");
    expect(def.critical).toBe(false);
    expect(def.tools?.().map((t) => t.name)).toEqual([
      "document_map",
      "document_read",
      "document_index",
      "document_find",
    ]);
    expect(def.configKeys).toBeUndefined();
  });
});
