import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { LspModule } from "../src/modules/lsp/module";

/** Записать дерево файлов проекта (пути относительно base). */
function mkProject(base: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(base, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }
}

const ctxOf = (baseDir: string) => ({ baseDir, logger: { warn: () => {} } }) as any;
const writeCall = (path: string) =>
  ({ id: "call-1", name: "write_file", arguments: { path } }) as any;

/** Прогнать пост-проверку записи и вернуть изменённый результат тула. */
async function runWrite(
  module: LspModule,
  baseDir: string,
  path: string,
  output = "file written ok",
): Promise<{ success: boolean; output: string }> {
  // Тесты пост-проверки работают на ТЁПЛОМ соединении: холодный старт теперь
  // прогревается в фоне и проверку пропускает (см. write-check-cold-start).
  (module as any).client.isWarm = () => true;
  const result = { success: true, output };
  await module.getPlugin().onAfterTool!(ctxOf(baseDir), writeCall(path), result as any);
  return result;
}

describe("LspModule", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lsp-test-"));
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it("passes a project root resolved with the server's workspaceMarkers", async () => {
    const baseDir = join(tmp, "nested");
    mkProject(baseDir, { "tsconfig.json": "{}", "src/a.ts": "export const a = 1;" });

    const module = new LspModule({ enabled: true } as any);
    let receivedProjectRoot: string | null = null;
    (module as any).client.checkFile = async (
      _filePath: string,
      _baseDirArg: string,
      _config: unknown,
      projectRoot: string,
    ) => {
      receivedProjectRoot = projectRoot;
      return { diagnostics: [], inconclusive: false };
    };
    await runWrite(module, baseDir, "src/a.ts");
    expect(receivedProjectRoot).toBe(baseDir);
  });

  it("appends an LSP check failed note when the server cannot start", async () => {
    const baseDir = join(tmp, "proj");
    mkProject(baseDir, { "src/a.ts": "export const a = 1;" });

    const module = new LspModule({ enabled: true } as any);
    (module as any).client.checkFile = async () => {
      throw new Error("npx typescript-language-server not found");
    };
    const result = await runWrite(module, baseDir, "src/a.ts");
    expect(result.output).toContain("[LSP check failed]");
  });

  it("appends a classified hint to an LSP check failure", async () => {
    const baseDir = join(tmp, "proj-hint");
    mkProject(baseDir, { "src/a.rs": "fn main() {}" });

    const module = new LspModule({
      enabled: true,
      servers: { rust: { command: "rust-analyzer", autoInstall: false } },
    } as any);
    (module as any).client.checkFile = async () => {
      throw new Error("rust-analyzer not found in PATH");
    };
    const result = await runWrite(module, baseDir, "src/a.rs");
    expect(result.output).toContain("[LSP check failed]");
    expect(result.output).toContain("install the language server");
  });

  it("exposes diagnose(baseDir) for /lsp doctor", async () => {
    const baseDir = join(tmp, "proj-diag");
    mkProject(baseDir, { "src/a.ts": "export const a = 1;" });

    const module = new LspModule({ enabled: true } as any);
    const diag = await module.diagnose(baseDir, {
      collectFiles: async () => [join(baseDir, "src", "a.ts")],
      findOnPath: () => null,
      offline: true,
      client: { probe: async () => {} } as any,
    });
    const ts = diag.servers.find((s) => s.language === "typescript");
    expect(ts?.reason).toBe("offline");
  });

  it("disables LSP for the session after N consecutive failures and says so once", async () => {
    const baseDir = join(tmp, "proj2");
    mkProject(baseDir, { "src/a.ts": "export const a = 1;" });

    const module = new LspModule({ enabled: true } as any);
    (module as any).client.checkFile = async () => {
      throw new Error("server not found");
    };

    // First two failures: keep the per-write note (existing behavior).
    for (let i = 0; i < 2; i++) {
      expect((await runWrite(module, baseDir, "src/a.ts")).output).toContain("[LSP check failed]");
    }

    // Third consecutive failure: one clear "unavailable" signal + disable.
    const third = await runWrite(module, baseDir, "src/a.ts");
    expect(third.output).toContain("LSP disabled");
    expect(third.output).toContain("unavailable");

    // Fourth and later: no per-write noise, no repeated signal.
    expect((await runWrite(module, baseDir, "src/a.ts")).output).toBe("file written ok");
    expect(module.isLspDisabled()).toBe(true);
  });

  it("does not disable after an isolated failure followed by a success", async () => {
    const baseDir = join(tmp, "proj3");
    mkProject(baseDir, { "src/a.ts": "export const a = 1;" });

    const module = new LspModule({ enabled: true } as any);
    let shouldFail = true;
    (module as any).client.checkFile = async () => {
      if (shouldFail) throw new Error("boom");
      return { diagnostics: [], inconclusive: false };
    };

    expect((await runWrite(module, baseDir, "src/a.ts")).output).toContain("[LSP check failed]");

    // succeed — resets the consecutive-failure counter
    shouldFail = false;
    await runWrite(module, baseDir, "src/a.ts");
    expect(module.isLspDisabled()).toBe(false);

    // fail twice more — still under the threshold because of the reset
    shouldFail = true;
    await runWrite(module, baseDir, "src/a.ts");
    await runWrite(module, baseDir, "src/a.ts");
    expect(module.isLspDisabled()).toBe(false);
  });

  it("disables only the failing server, keeping other servers active", async () => {
    const baseDir = join(tmp, "proj4");
    mkProject(baseDir, { "src/a.css": "body { color: red; }", "src/a.ts": "export const a = 1;" });

    const module = new LspModule({ enabled: true } as any);
    const checkedPaths: string[] = [];
    (module as any).client.checkFile = async (filePath: string) => {
      checkedPaths.push(filePath);
      if (filePath.endsWith(".css")) throw new Error("css server not found");
      return { diagnostics: [], inconclusive: false };
    };

    // Three consecutive CSS failures disable only the css server.
    for (let i = 0; i < 3; i++) await runWrite(module, baseDir, "src/a.css", "css written ok");
    expect(
      module.isServerDisabled(
        "npx:--yes --package vscode-langservers-extracted --package typescript@5 vscode-css-language-server --stdio",
      ),
    ).toBe(true);
    expect(module.isLspDisabled()).toBe(true);

    // A 4th CSS write after disable: silenced, output untouched.
    expect((await runWrite(module, baseDir, "src/a.css", "css written ok")).output).toBe(
      "css written ok",
    );

    // A TS check still runs — checkFile really received the .ts path.
    const tsResult = await runWrite(module, baseDir, "src/a.ts", "ts written ok");
    expect(
      module.isServerDisabled(
        "npx:--yes --package typescript-language-server --package typescript@5 typescript-language-server --stdio",
      ),
    ).toBe(false);
    expect(tsResult.output).toBe("ts written ok");
    expect(checkedPaths.some((p) => p.endsWith("a.ts"))).toBe(true);
  });

  it("exposes live global flags and applies hot toggles", () => {
    const module = new LspModule({ enabled: true } as any);
    expect(module.getFlags()).toEqual({ enabled: true, offline: false });

    module.setEnabled(false);
    module.setOffline(true);
    expect(module.getFlags()).toEqual({ enabled: false, offline: true });

    // The client carries the offline flag into its launch resolution.
    expect((module as any).client.getOffline()).toBe(true);
  });

  it("defaults getFlags when lsp is explicitly disabled", () => {
    const module = new LspModule({ enabled: false } as any);
    expect(module.getFlags()).toEqual({ enabled: false, offline: false });
  });
});
