import { describe, it, expect } from "vitest";
import {
  checkArtifactClaims,
  checkUnverifiedOutput,
} from "../src/core/hallucination/artifact-claim";

describe("checkArtifactClaims", () => {
  it("contradicts a 'valid' claim about a missing file", () => {
    const r = checkArtifactClaims("Файл schema.drawio создан и валиден.", [
      { path: "schema.drawio", exists: false },
    ]);
    expect(r).not.toBeNull();
    expect(r?.path).toBe("schema.drawio");
  });

  it("contradicts a 'valid' claim about an unparseable file", () => {
    const r = checkArtifactClaims("Done, schema.drawio is valid.", [
      { path: "schema.drawio", exists: true, parseError: "Mismatched tag (line 1)" },
    ]);
    expect(r?.snippet).toContain("Mismatched tag");
  });

  it("accepts existing parseable artifacts and neutral mentions", () => {
    expect(
      checkArtifactClaims("Файл fizzbuzz.py создан и готов к запуску.", [
        { path: "fizzbuzz.py", exists: true },
      ]),
    ).toBeNull();
    // No success wording about the file — just a mention.
    expect(
      checkArtifactClaims("Проверь fizzbuzz.py завтра.", [
        { path: "fizzbuzz.py", exists: false },
      ]),
    ).toBeNull();
  });
});

describe("checkUnverifiedOutput", () => {
  const fenced = "Покажу вывод программы текстом:\n```\n1 2 Fizz\n```";
  const noExec = [{ name: "write_file", ok: true, text: "written" }];

  it("contradicts framed-as-executed output with no execution behind it", () => {
    const r = checkUnverifiedOutput(fenced, noExec);
    expect(r).not.toBeNull();
    expect(r?.tool).toBe("no-execution");
  });

  it("accepts hedged (expected/example) output", () => {
    expect(
      checkUnverifiedOutput("Ожидаемый вывод программы (для справки):\n```\n1 2 Fizz\n```", noExec),
    ).toBeNull();
  });

  it("accepts output backed by a successful bash run", () => {
    expect(
      checkUnverifiedOutput(fenced, [
        ...noExec,
        { name: "bash", ok: true, text: "1\n2\nFizz" },
      ]),
    ).toBeNull();
  });

  it("ignores code blocks not framed as execution results", () => {
    expect(
      checkUnverifiedOutput("Вот код:\n```python\nprint(1)\n```", noExec),
    ).toBeNull();
  });
});
