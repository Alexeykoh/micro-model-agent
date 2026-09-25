import { describe, it, expect } from "vitest";
import { preValidateSyntax } from "../../src/tools/syntax-validator";

describe("preValidateSyntax JSON / JSONC", () => {
  it("accepts a commented tsconfig.json (JSONC)", async () => {
    const content = `{
  // line comment
  "compilerOptions": {
    "strict": true, /* block comment */
  },
}`;
    const result = await preValidateSyntax("tsconfig.json", content, process.cwd());
    expect(result.valid).toBe(true);
  });

  it("accepts a .jsonc file with trailing commas", async () => {
    const result = await preValidateSyntax(
      "settings.jsonc",
      `{ "a": [1, 2, 3,], }`,
      process.cwd(),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects genuinely broken JSON", async () => {
    const result = await preValidateSyntax("broken.json", "{ nope", process.cwd());
    expect(result.valid).toBe(false);
  });
});
