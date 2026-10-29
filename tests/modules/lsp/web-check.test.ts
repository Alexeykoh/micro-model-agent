// Guard: структурная диагностика файла для панели LSP (B-41, W1 спеки
// `2026-10-28-webui-lsp-file-diagnostics-design.md`).
//
// Панель получает данные (строка/колонка/уровень/текст), путь приходит из
// браузера — jail обязателен, отказы приходят данными, а не исключением.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWebCheck, WEB_CHECK_TIMEOUT_MS, type WebCheckDeps } from "../../../src/modules/lsp/web-check";
import { DEFAULT_LSP_CONFIG } from "../../../src/modules/lsp/config";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mma-web-lsp-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a: number = 1;\n", "utf8");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(overrides: Partial<WebCheckDeps> = {}): WebCheckDeps {
  return {
    baseDir: dir,
    config: structuredClone(DEFAULT_LSP_CONFIG),
    client: {
      isWarm: () => true,
      warmup: async () => {},
      checkFile: async () => ({
        inconclusive: false,
        diagnostics: [
          { range: { start: { line: 4, character: 2 } }, severity: 1, message: "boom" },
          { range: { start: { line: 7, character: 0 } }, severity: 2, message: "warn" },
        ],
      }),
    },
    health: {
      isDisabled: () => false,
      recordFailure: () => ({ disabled: false, text: "" }),
      warn: () => {},
      reset: () => {},
    } as never,
    logger: null,
    failureNote: () => "",
    ...overrides,
  };
}

describe("web LSP: диагностика одного файла", () => {
  it("отдаёт диагностики данными (строка/колонка с 1)", async () => {
    const r = await runWebCheck("src/a.ts", deps());

    expect(r.ok).toBe(true);
    expect(r.path).toBe("src/a.ts");
    expect(r.diagnostics[0]).toEqual({ line: 5, column: 3, severity: "error", message: "boom" });
    // Ошибки идут первыми, предупреждения после.
    expect(r.diagnostics.map((d) => d.severity)).toEqual(["error", "warning"]);
  });

  it("выход за workspace — outside-workspace", async () => {
    const r = await runWebCheck("../secret.txt", deps());

    expect(r.ok).toBe(false);
    expect(r.error).toBe("outside-workspace");
    expect(r.diagnostics).toEqual([]);
  });

  it("нет файла — not-found", async () => {
    const r = await runWebCheck("src/nope.ts", deps());

    expect(r.ok).toBe(false);
    expect(r.error).toBe("not-found");
  });

  it("LSP выключен — disabled", async () => {
    const config = structuredClone(DEFAULT_LSP_CONFIG);
    config.enabled = false;
    const r = await runWebCheck("src/a.ts", deps({ config }));

    expect(r.ok).toBe(false);
    expect(r.error).toBe("disabled");
  });

  it("пустой путь — not-found, без падения", async () => {
    const r = await runWebCheck("   ", deps());

    expect(r.ok).toBe(false);
    expect(r.error).toBe("not-found");
  });

  it("таймаут сервера — не «ошибок нет», а lsp-timeout", async () => {
    const r = await runWebCheck(
      "src/a.ts",
      deps({
        client: {
          isWarm: () => true,
          warmup: async () => {},
          checkFile: async () => ({ inconclusive: true, diagnostics: [] }),
        },
      }),
    );

    expect(r.ok).toBe(false);
    expect(r.error).toBe("lsp-timeout");
    expect(r.diagnostics).toEqual([]);
  });

  it("панель ждёт файл дольше, чем агентский lsp_check", async () => {
    // Живой прогон: на этой машине холодная проверка TS-файла занимает ~9.6 с,
    // старый бюджет 8 с отдавал lsp-timeout при живом сервере.
    let budget = 0;
    await runWebCheck(
      "src/a.ts",
      deps({
        client: {
          isWarm: () => true,
          warmup: async () => {},
          checkFile: async (_f, _b, _s, _p, timeoutMs) => {
            budget = Number(timeoutMs);
            return { inconclusive: false, diagnostics: [] };
          },
        },
      }),
    );

    expect(budget).toBe(WEB_CHECK_TIMEOUT_MS);
    expect(WEB_CHECK_TIMEOUT_MS).toBeGreaterThan(8000);
  });

  it("отличает «сервер не настроен» от «сервер не ответил»", async () => {
    writeFileSync(join(dir, "notes.md"), "# hi\n", "utf8");

    const r = await runWebCheck("notes.md", deps());

    // md не обслуживается ни одним сервером: панель не должна врать про таймаут.
    expect(r.ok).toBe(false);
    expect(r.error).toBe("unsupported");
    expect(r.diagnostics).toEqual([]);
  });

  it("не держит запрос на холодном старте: отдаёт «starting» + retryAfterMs", async () => {
    // Большой проект (Angular 11 монорепо) грузит tsserver 15–60 с: панель
    // должна сама повторить запрос, а не получать «сервер не ответил» через 15 с.
    const started = Date.now();
    const r = await runWebCheck(
      "src/a.ts",
      deps({
        warmWaitMs: 50,
        client: {
          isWarm: () => false,
          warmup: () => new Promise<void>(() => {}),
          checkFile: async () => {
            throw new Error("must not run while starting");
          },
        } as never,
      }),
    );

    expect(r.ok).toBe(false);
    expect(r.error).toBe("starting");
    expect(r.retryAfterMs).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("отдаёт причину падения сервера, а не только «не ответил»", async () => {    const r = await runWebCheck(
      "src/a.ts",
      deps({
        failureNote: (_key: string, _cfg: unknown, message: string) => `[LSP check failed: ${message}]`,
        client: {
          isWarm: () => false,
          warmup: async () => {
            throw Object.assign(new Error("LSP server exited"), {
              stderrTail: "SyntaxError: Unexpected token '?'",
            });
          },
          checkFile: async () => {
            throw new Error("must not run");
          },
        } as never,
      }),
    );

    expect(r.ok).toBe(false);
    expect(r.error).toBe("lsp-failed");
    expect(r.reason).toContain("SyntaxError");
  });
});
