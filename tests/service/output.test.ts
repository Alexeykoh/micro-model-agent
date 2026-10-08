import { describe, expect, it } from "vitest";
import {
  buildOutputInstruction,
  extractJson,
  parseStructured,
  validateAgainstSchema,
} from "../../src/modules/service/runtime/output";

describe("structured output", () => {
  it("validates required fields, types, enum and additionalProperties", () => {
    const schema = {
      type: "object",
      required: ["title", "score"],
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        score: { type: "number" },
        kind: { enum: ["a", "b"] },
      },
    };
    expect(validateAgainstSchema({ title: "x", score: 1 }, schema)).toEqual({ ok: true });
    expect(validateAgainstSchema({ score: 1 }, schema)).toMatchObject({ ok: false, detail: "field `title` missing" });
    expect(validateAgainstSchema({ title: "x", score: "n" }, schema)).toMatchObject({ ok: false });
    expect(validateAgainstSchema({ title: "x", score: 1, extra: 2 }, schema)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("unexpected field"),
    });
    expect(validateAgainstSchema({ title: "x", score: 1, kind: "c" }, schema)).toMatchObject({ ok: false });
  });

  it("extracts fenced JSON and repairs broken JSON", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('preamble {"a":1,} trailing')).toEqual({ a: 1 });
  });

  it("parses and validates a response end-to-end", () => {
    const output = { format: "json" as const, schema: { type: "object", required: ["title"], properties: { title: { type: "string" } } } };
    expect(parseStructured('{"title":"ok"}', output)).toEqual({ ok: true, data: { title: "ok" } });
    const bad = parseStructured("not json at all", output);
    expect(bad.ok).toBe(false);
  });

  it("builds an instruction naming JSON-only output", () => {
    const instruction = buildOutputInstruction({ format: "json", schema: { type: "object" } });
    expect(instruction).toContain("ONLY");
    expect(instruction).toContain('"type":"object"');
  });
});
