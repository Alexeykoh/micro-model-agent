/**
 * W10.5: strict-валидация structured output — опечатка в схеме не проходит молча.
 */
import { describe, expect, it } from "vitest";
import { parseStructured, validateAgainstSchema } from "../../src/modules/service/runtime/output";

describe("structured output schema strictness", () => {
  it("rejects an unknown type instead of silently passing", () => {
    const r = validateAgainstSchema(
      { age: "x" },
      { type: "object", properties: { age: { type: "strng" } } },
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.detail).toMatch(/unknown type/i);
  });

  it("treats null as missing for a required field", () => {
    const r = validateAgainstSchema(
      { age: null },
      { type: "object", required: ["age"], properties: { age: { type: "number" } } },
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.detail).toMatch(/missing/);
  });

  it("rejects properties without type:object", () => {
    const r = validateAgainstSchema(
      { a: 1 },
      { properties: { a: { type: "number" } } },
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.detail).toMatch(/require type:"object"/);
  });

  it("still accepts a valid nested object", () => {
    const r = validateAgainstSchema(
      { title: "ok", score: 3, tags: ["a"] },
      {
        type: "object",
        required: ["title", "score"],
        properties: {
          title: { type: "string" },
          score: { type: "number" },
          tags: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    );
    expect(r).toEqual({ ok: true });
  });

  it("fails parseStructured for a malformed schema", () => {
    const r = parseStructured('{"a":1}', {
      format: "json",
      schema: { type: "object", properties: { a: { type: "integerr" } } },
    });
    expect(r.ok).toBe(false);
  });
});
