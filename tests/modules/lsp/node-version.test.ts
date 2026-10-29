import { describe, expect, it } from "vitest";
import {
  looksLikeNodeVersionCrash,
  pinForOldNode,
  readNodeVersion,
} from "../../../src/modules/lsp/node-version";

/**
 * Версия Node — единственное, что отличает «сервер слишком новый для этого
 * рантайма» от «сервер битый». Node 16 + `typescript-language-server` 4+ падает
 * до `initialize`, и без этой информации doctor советовал переустановить ту же
 * несовместимую версию.
 */

describe("readNodeVersion", () => {
  it("parses the major from node --version output", () => {
    expect(readNodeVersion("node", () => "v16.20.2\n")).toEqual({ raw: "v16.20.2", major: 16 });
    expect(readNodeVersion("node", () => "v22.11.0")).toEqual({ raw: "v22.11.0", major: 22 });
  });

  it("returns null when node is missing or output is unrecognised", () => {
    expect(
      readNodeVersion("node", () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
    expect(readNodeVersion("node", () => "not-a-version")).toBeNull();
  });
});

describe("looksLikeNodeVersionCrash", () => {
  it("recognises JS runtime failures", () => {
    expect(looksLikeNodeVersionCrash("SyntaxError: Unexpected token '?'")).toBe(true);
    expect(looksLikeNodeVersionCrash("require() of ES Module ... ERR_REQUIRE_ESM")).toBe(true);
    expect(looksLikeNodeVersionCrash("ERR_UNKNOWN_BUILTIN_MODULE: node:fs/promises")).toBe(true);
    expect(looksLikeNodeVersionCrash("ReferenceError: structuredClone is not defined")).toBe(true);
  });

  it("does not claim a version crash for ordinary failures", () => {
    expect(looksLikeNodeVersionCrash("LSP request timeout: initialize")).toBe(false);
    expect(looksLikeNodeVersionCrash("spawn npx ENOENT")).toBe(false);
  });
});

describe("pinForOldNode", () => {
  it("pins the server to a build that runs on old Node", () => {
    expect(pinForOldNode("typescript-language-server")).toBe("typescript-language-server@3.3.2");
  });

  it("leaves package versions and unknown packages alone", () => {
    expect(pinForOldNode("typescript@5")).toBe("typescript@5");
    expect(pinForOldNode("pyright")).toBe("pyright");
  });
});
