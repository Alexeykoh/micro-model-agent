// Guard: пакетная проверка изменённых файлов — bounded очередь, общий бюджет,
// честные отказы (git/нет изменений), а не минутное ожидание.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChangedChecks, type ChangedCheckDeps } from "../../../src/modules/lsp/changed-check";
import { DEFAULT_LSP_CONFIG } from "../../../src/modules/lsp/config";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mma-changed-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src", "b.ts"), "export const b = 1;\n");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(overrides: Partial<ChangedCheckDeps> = {}): ChangedCheckDeps {
  return {
    baseDir: dir,
    config: structuredClone(DEFAULT_LSP_CONFIG),
    client: {
      isWarm: () => true,
      warmup: async () => {},
      checkFile: async () => ({
        inconclusive: false,
        diagnostics: [
          { range: { start: { line: 0, character: 0 } }, severity: 1, message: "boom" },
        ],
      }),
    },
    health: { isDisabled: () => false, warn: () => {}, reset: () => {}, recordFailure: () => ({ disabled: false, text: "" }) } as never,
    logger: null,
    failureNote: () => "",
    listChanged: () => ["src/a.ts", "src/b.ts"],
    ...overrides,
  };
}

describe("runChangedChecks", () => {
  it("проверяет изменённые файлы по очереди и отдаёт диагностики", async () => {
    const r = await runChangedChecks(deps());

    expect(r.ok).toBe(true);
    expect(r.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(r.files[0].diagnostics[0].message).toBe("boom");
  });

  it("нет изменений — no-changes без исключения", async () => {
    const r = await runChangedChecks(deps({ listChanged: () => [] }));

    expect(r.ok).toBe(false);
    expect(r.error).toBe("no-changes");
  });

  it("git недоступен — git-unavailable, панель не ломается", async () => {
    const r = await runChangedChecks(
      deps({
        listChanged: () => {
          throw new Error("not a git repository");
        },
      }),
    );

    expect(r.ok).toBe(false);
    expect(r.error).toBe("git-unavailable");
  });

  it("общий бюджет исчерпан — truncated, а не бесконечная очередь", async () => {
    const r = await runChangedChecks(
      deps({
        listChanged: () => ["src/a.ts", "src/b.ts", "src/c.ts"],
        totalBudgetMs: -1,
      }),
    );

    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.files).toEqual([]);
  });
});
