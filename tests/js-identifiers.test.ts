import { describe, it, expect } from "vitest";
import {
  isFilePathLike,
  extractFileLikeTokens,
  stripUrls,
} from "../src/modules/hallucination/js-identifiers";

describe("isFilePathLike", () => {
  it("accepts bare files with a known file extension", () => {
    expect(isFilePathLike("config.json")).toBe(true);
    expect(isFilePathLike("helper.ts")).toBe(true);
    expect(isFilePathLike("main.c")).toBe(true);
  });

  it("rejects bare domain names in any TLD (not files)", () => {
    expect(isFilePathLike("Gismeteo.by")).toBe(false);
    expect(isFilePathLike("weather.com")).toBe(false);
    expect(isFilePathLike("example.xyz")).toBe(false);
    expect(isFilePathLike("site.anynewtld")).toBe(false);
  });

  it("accepts path tokens regardless of extension", () => {
    expect(isFilePathLike("src/index.ts")).toBe(true);
    expect(isFilePathLike("dist/app.js.map")).toBe(true);
    expect(isFilePathLike("docs/Report.final")).toBe(true);
  });

  it("rejects JS member access and technology names", () => {
    expect(isFilePathLike("process.env")).toBe(false);
    expect(isFilePathLike("console.log")).toBe(false);
    expect(isFilePathLike("node.js")).toBe(false);
    expect(isFilePathLike("react.js")).toBe(false);
  });

  it("rejects extension-only path segments (empty stem)", () => {
    expect(isFilePathLike("tsx/.ts")).toBe(false);
    expect(isFilePathLike("src/.env")).toBe(false);
    expect(isFilePathLike(".gitignore")).toBe(false);
    expect(isFilePathLike("dist\\app.js.map")).toBe(true);
    expect(isFilePathLike("src/App.TSX")).toBe(true);
  });
});

describe("extractFileLikeTokens", () => {
  it("extracts real file tokens but not domains", () => {
    expect(extractFileLikeTokens("Use config.json; see Gismeteo.by or weather.com.")).toEqual([
      "config.json",
    ]);
  });

  it("strips URLs before extraction (as auditor/factual do)", () => {
    expect(
      extractFileLikeTokens(
        stripUrls("Clone https://github.com/example/repo.git then edit src/main.ts"),
      ),
    ).toEqual(["src/main.ts"]);
  });

  it("extracts no tokens from an extension-list phrase", () => {
    expect(extractFileLikeTokens("Проверить что остались только .tsx/.ts файлы")).toEqual([]);
  });

  it("ignores method calls glued to an open paren (not files)", () => {
    expect(
      extractFileLikeTokens("setTodos((prev) => [...prev, { id: 1 }]); todos.map((t) => t.text)"),
    ).toEqual([]);
  });

  it("still extracts a real sourcemap next to a method call", () => {
    expect(extractFileLikeTokens("see dist/bundle.js.map; prev.map((t) => t)")).toEqual([
      "dist/bundle.js.map",
    ]);
  });
});

describe("stripUrls", () => {
  it("removes http(s) URLs", () => {
    const out = stripUrls("See https://example.com/page and http://a.b")
      .replace(/\s+/g, " ")
      .trim();
    expect(out).toBe("See and");
  });
});
