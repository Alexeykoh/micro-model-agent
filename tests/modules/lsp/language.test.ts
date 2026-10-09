import { describe, expect, it } from "vitest";
import {
  extensionOf,
  languageIdForPath,
  serverKeyForPath,
} from "../../../src/modules/lsp/language";

describe("extensionOf", () => {
  it("handles both separators", () => {
    expect(extensionOf("C:\\a\\b.ts")).toBe("ts");
    expect(extensionOf("/a/b/c.tsx")).toBe("tsx");
  });

  it("returns empty for dotfiles, dirs and no extension", () => {
    expect(extensionOf("/a/.gitignore")).toBe("");
    expect(extensionOf("/a/.git")).toBe("");
    expect(extensionOf("Makefile")).toBe("");
    expect(extensionOf("src")).toBe("");
  });
});

describe("languageIdForPath", () => {
  it("maps protocol language ids", () => {
    expect(languageIdForPath("a.ts")).toBe("typescript");
    expect(languageIdForPath("a.tsx")).toBe("typescriptreact");
    expect(languageIdForPath("a.mjs")).toBe("javascript");
    expect(languageIdForPath("a.py")).toBe("python");
    expect(languageIdForPath("a.rs")).toBe("rust");
    expect(languageIdForPath("a.go")).toBe("go");
  });

  it("falls back to plaintext", () => {
    expect(languageIdForPath("a.txt")).toBe("plaintext");
    expect(languageIdForPath("a.md")).toBe("markdown");
    expect(languageIdForPath("README")).toBe("plaintext");
  });
});

describe("serverKeyForPath", () => {
  it("maps to the lsp.servers key namespace", () => {
    expect(serverKeyForPath("a.ts")).toBe("typescript");
    expect(serverKeyForPath("a.tsx")).toBe("typescript");
    expect(serverKeyForPath("a.jsx")).toBe("javascript");
    expect(serverKeyForPath("a.py")).toBe("python");
  });

  it("routs scss to the css server while languageId stays scss", () => {
    expect(serverKeyForPath("a.scss")).toBe("css");
    expect(languageIdForPath("a.scss")).toBe("scss");
  });

  it("returns null for unsupported files", () => {
    expect(serverKeyForPath("a.txt")).toBeNull();
    expect(serverKeyForPath("a.md")).toBeNull();
  });
});
