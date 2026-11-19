import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runPreWriteCheck, type WriteCheckDeps } from "../../../src/modules/lsp/write-check";
import type { LspClient } from "../../../src/modules/lsp/client";
import type { ToolCall, ToolContext } from "../../../src/tools/types";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mma-pre-write-"));
  writeFileSync(join(dir, "a.ts"), "const a = 1;\n", "utf-8");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(errors: number): WriteCheckDeps {
  const client = {
    isWarm: () => true,
    warmup: async () => {},
    checkContent: async () => ({
      diagnostics: Array.from({ length: errors }, () => ({
        severity: 1,
        message: "Type 'string' is not assignable to type 'number'",
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
  ({ id: "c1", name: "write_file", arguments: { path: "a.ts", content } }) as ToolCall;
const ctx = () => ({ baseDir: dir }) as ToolContext;

describe("LSP pre-write draft check", () => {
  it("blocks a draft with type errors", async () => {
    const msg = await runPreWriteCheck(deps(1), ctx(), call("const a: number = 'x';"));
    expect(msg).toContain("Draft not written");
    expect(msg).toContain("a.ts");
  });

  it("allows a clean draft and non-write tools", async () => {
    expect(await runPreWriteCheck(deps(0), ctx(), call("const a = 1;"))).toBeNull();
    const read = { id: "c2", name: "read_file", arguments: { path: "a.ts" } } as ToolCall;
    expect(await runPreWriteCheck(deps(1), ctx(), read)).toBeNull();
  });

  it("allows when the server is cold (fail-open)", async () => {
    const d = deps(1);
    d.client.isWarm = () => false;
    expect(await runPreWriteCheck(d, ctx(), call("const a: number = 'x';"))).toBeNull();
  });
});
