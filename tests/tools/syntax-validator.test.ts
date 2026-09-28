import { describe, it, expect } from "vitest";
import { preValidateSyntax, checkXmlWellFormed } from "../../src/tools/syntax-validator";

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

describe("checkXmlWellFormed", () => {
  it("accepts a well-formed document with PI, comments, CDATA and quoted >", () => {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!-- a comment -->
<mxfile host="a>b"><diagram name="d"><mxGraphModel><root><mxCell id="0"/><mxCell id="1"><![CDATA[<not-a-tag>]]></mxCell></root></mxGraphModel></diagram></mxfile>`;
    expect(checkXmlWellFormed(content)).toBeNull();
  });

  it("rejects the drawio failure mode: self-closed <diagram/> plus stray </diagram>", () => {
    const content = `<mxfile><diagram name="d"/><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>`;
    const error = checkXmlWellFormed(content);
    expect(error).toContain("Mismatched tag");
  });

  it("rejects mismatched and unclosed tags", () => {
    expect(checkXmlWellFormed("<a><b></a></b>")).toContain("Mismatched tag");
    expect(checkXmlWellFormed("<a><b></b>")).toContain("Unclosed tag");
    expect(checkXmlWellFormed("</a>")).toContain("Stray closing tag");
  });

  it("preValidateSyntax routes .drawio through the XML check", async () => {
    const good = await preValidateSyntax("schema.drawio", "<mxfile><diagram></diagram></mxfile>", process.cwd());
    expect(good.valid).toBe(true);
    const bad = await preValidateSyntax(
      "schema.drawio",
      `<mxfile><diagram name="d"/><mxGraphModel></mxGraphModel></diagram></mxfile>`,
      process.cwd(),
    );
    expect(bad.valid).toBe(false);
    expect(bad.error).toContain("Mismatched tag");
  });
});
