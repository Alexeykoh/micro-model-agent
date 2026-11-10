import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runPreWriteCheck, type WriteCheckDeps } from "../../../src/modules/lsp/write-check";
import type { LspClient } from "../../../src/modules/lsp/client";
import type { ToolCall, ToolContext } from "../../../src/tools/types";

/**
 * Дефект B (спека 0.25.2): неразрешённый алиас на холодном индексе роняет типы
 * импорта → каскад `implicit any` / `cannot find name`. Раньше он блокировал
 * корректную запись, и модель обходила баг явными аннотациями в чужом проекте.
 */

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mma-alias-cascade-"));
  writeFileSync(join(dir, "a.tsx"), "export const a = 1;\n", "utf-8");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(messages: string[]): WriteCheckDeps {
  const client = {
    isWarm: () => true,
    warmup: async () => {},
    checkContent: async () => ({
      diagnostics: messages.map((message) => ({
        severity: 1,
        message,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      })),
      inconclusive: false,
    }),
  } as unknown as LspClient;
  return {
    config: { enabled: true, timeout: 100, servers: { typescript: { command: "tsc" } } },
    client,
    health: {
      isDisabled: () => false,
      reset: () => {},
      warn: () => {},
      warmInBackground: () => {},
    } as unknown as WriteCheckDeps["health"],
    logger: null,
    log: () => {},
  };
}

const call = (content: string): ToolCall =>
  ({ id: "c1", name: "write_file", arguments: { path: "a.tsx", content } }) as ToolCall;
const ctx = () => ({ baseDir: dir }) as ToolContext;

describe("LSP pre-write alias cascade (B)", () => {
  it("does not block a draft whose alias failure cascades into implicit any", async () => {
    const d = deps([
      "Cannot find module '@/lib/schemas/product' or its corresponding type declarations.",
      "Parameter 'p' implicitly has an 'any' type.",
    ]);
    const draft = "import type { Product } from '@/lib/schemas/product';\nproducts.map((p) => p.id);\n";
    expect(await runPreWriteCheck(d, ctx(), call(draft))).toBeNull();
  });

  it("does not block a cascaded 'cannot find name'", async () => {
    const d = deps([
      "Cannot find module '@/lib/types' or its corresponding type declarations.",
      "Cannot find name 'Product'.",
    ]);
    expect(await runPreWriteCheck(d, ctx(), call("const x: Product = 1;\n"))).toBeNull();
  });

  it("still blocks a real type error", async () => {
    const d = deps(["Type 'string' is not assignable to type 'number'."]);
    const msg = await runPreWriteCheck(d, ctx(), call("const a: number = 'x';\n"));
    expect(msg).toContain("Draft not written");
  });

  it("still blocks implicit any when no alias failed", async () => {
    const d = deps(["Parameter 'p' implicitly has an 'any' type."]);
    const msg = await runPreWriteCheck(d, ctx(), call("products.map((p) => p.id);\n"));
    expect(msg).toContain("Draft not written");
  });
});
