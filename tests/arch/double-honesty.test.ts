import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Gate: test doubles must not manufacture the appearance of coverage (W9).
 *
 * A double that reimplements a class is a second, unverified copy of it: when
 * the real class grows a method, the double keeps compiling, and the tests stay
 * green while the real path is never exercised. Four defects reached `master`
 * with fully green suites, and the common thread was a stub standing in for the
 * thing under test.
 *
 * This gate does not forbid doubles — most tests need them. It forbids a double
 * from silently diverging: either it derives from the real type (so a new
 * method is a compile error), or the gap is listed with a reason.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CONTEXT_MANAGER = join(REPO_ROOT, "src", "core", "context", "manager.ts");
const TESTS_ROOT = join(REPO_ROOT, "tests", "core");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);

/**
 * Methods of `ContextManager` the double in `tests/core/agent.test.ts` does NOT
 * provide. Each absent method is a place where the double answers nothing while
 * the real object would — so it must be a deliberate, recorded choice.
 */
export const UNCOVERED_CONTEXT_METHODS: Record<string, string> = {
  // ── Вызываются петлёй, но дубль не отвечает ──────────────────────────────
  // Это самый опасный класс: тест зелёный, а код петли на этом методе не
  // отработал ни разу. Причина у каждого — почему метод НЕ участвует в
  // проверяемом поведении `Agent.run` в этих тестах.
  beginTurn: "нумерация ходов; тесты не проверяют идентичность seq — покрыто turn-тестами",
  calibrate: "калибровка оценки токенов; проверяется в context budget тестах с реальным менеджером",
  checkOverflowAllowed: "проверка переполнения перед суммаризацией; наполняется только overflow-тестами",
  clear: "сброс сессии; проверяется отдельно, в цикле хода не встречается",
  compactAdaptive: "адаптивная компакция; отдельные тесты с реальным ContextManager",
  getBreakdown: "структура бюджета для web; покрыта getQuality-тестами с реальным менеджером",
  getContextTokens: "единственный вход порогов (W4); покрыт budget-тестами, в цикле считает дубль",
  getKnownFiles: "список известных файлов для factual-проверки; пустой список не меняет вердикт теста",
  getOverflowCooldown: "кулдаун after-tool (W4); проверяется отдельным инвариантным тестом",
  getPolicy: "режим контекста legacy|v2; переключается конфигом, в дефолтных тестах один путь",
  getQualityBreakdown: "web-детализация качества (спека context-quality-breakdown)",
  getToolResultKeep: "сколько результатов тулов хранить; дефолт совпадает с неявным в дубле",
  needsIntervalCompaction: "интервальная компакция; проверяется отдельным тестом предиката",
  noteMissingUsage: "провай provider usage без счётчиков; дубль имитирует нулевое потребление",
  resetUserTurn: "сброс хода пользователя; в тестах ход всегда один и полный",
  thinkingLevel: "уровень размышления из set-thinking; в Agent.run приходит из конфига",
  // ── Не вызываются петлёй; дубль не обязан их имитировать ───────────────
  addPendingImage: "очередь изображений; изображения идут через web/attach-image, не через цикл",
  clearPendingImages: "сброс очереди изображений; вместе с addPendingImage",
  configureLedger: "подключение durable-леджера делает createContextManager, не AgentDeps",
  getCompactionBlock: "блок промпта о последней компакции; рендерится в prompt, не в цикле",
  getEstimateDiagnostics: "диагностика оценки токенов; веб-инструмент диагностики",
  getHistoryTokens: "сводка по истории; цикл берёт getEstimatedTokens",
  getPendingImages: "чтение очереди изображений; вместе с addPendingImage",
  hasPendingImages: "наличие картинок в очереди; вместе с addPendingImage",
  pruneStaleToolResults: "подрезка старых результатов; цикл зовёт через compact-предикат",
  seqOf: "внутренний helper нумерации; проверяется turn-тестами",
  setPlanSummaryProvider: "сеттер провайдера сводки плана; ставится в bootstrap, не в AgentDeps",
  onCompact: "хук после компакции; ставится в context-factory, не в AgentDeps",
  wasLastJumpImplausible: "диагностика калибровки; веб-панель качества",
  getSnapshot: "снапшот контекста для HostStateSnapshot; веб-поверхность, не цикл",
  setProgressDiagnosticSink: "сеттер трекера no-progress; ставится в createContextManager",
};

/** Public methods declared on `ContextManager`, as an object literal. */
export function contextManagerMethods(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/^  (?:async )?([a-zA-Z][a-zA-Z0-9_]*)\(/gm)) {
    names.add(m[1]);
  }
  // Геттеры объявлены как `get foo(`; регулярка выше их не берёт.
  for (const m of source.matchAll(/^  get ([a-zA-Z][a-zA-Z0-9_]*)\(/gm)) names.add(m[1]);
  return [...names].filter((n) => n !== "constructor").sort();
}

/** Ключи, которые дубль реально предоставляет (объектные методы-моки). */
export function doubleKeys(source: string): string[] {
  return [...source.matchAll(/^    ([a-zA-Z][a-zA-Z0-9_]*): vi\.fn/gm)].map((m) => m[1]);
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) out.push(join(dir, entry.name));
  }
}

/** `as any` / `as unknown as` в тестах ядра: счётчик может только уменьшаться. */
export function countUnsafeCasts(dir: string): number {
  const files: string[] = [];
  walk(dir, files);
  let total = 0;
  for (const f of files) {
    const text = readFileSync(f, "utf-8");
    total += (text.match(/\bas any\b/g) ?? []).length;
    total += (text.match(/\bas unknown as\b/g) ?? []).length;
  }
  return total;
}

/**
 * Швы петли и тесты, которые через них проходят. Шов подменяет ровно ту часть,
 * которую тест хочет контролировать, — и вместе с ней исчезает проверка
 * реального пути. Парный тест (на настоящем исполнителе) — то, что отличает
 * контролируемый тест от иллюзии покрытия.
 */
export const SEAM_COVERAGE: Array<{ file: string; seam: string; paired: boolean; where: string }> = [
  {
    file: "tests/core/agent-critic.test.ts",
    seam: "criticOverride",
    paired: true,
    where: "tests/core/agent-hallucination.test.ts — реальный критик через Agent.run",
  },
  {
    file: "tests/core/agent.test.ts",
    seam: "createMockDeps (needsCompaction/getToolDefinitions пустые)",
    paired: true,
    where: "tests/core/tool-batch-honest-stop.test.ts — реальный путь ответа тула",
  },
  {
    file: "tests/core/subagent-parallel-e2e.test.ts",
    seam: "agentFactory",
    paired: true,
    where: "tests/core/tool-batch-parallel.test.ts — параллельные сабагенты без фабрики",
  },
];

describe("gate: doubles must not fake coverage (W9)", () => {
  const agentTest = readFileSync(join(TESTS_ROOT, "agent.test.ts"), "utf-8");

  it("the ContextManager double has a recorded entry for every method it lacks", () => {
    const real = contextManagerMethods(readFileSync(CONTEXT_MANAGER, "utf-8"));
    const provided = new Set(doubleKeys(agentTest));
    const missing = real.filter((m) => !provided.has(m));
    const undocumented = missing.filter((m) => !UNCOVERED_CONTEXT_METHODS[m]);
    expect(
      undocumented,
      `ContextManager methods the double silently omits. Either add them to the ` +
        `double or record a reason in UNCOVERED_CONTEXT_METHODS: ${undocumented.join(", ")}`,
    ).toEqual([]);
  });

  it("lists no method in the gap table that the double actually provides", () => {
    const provided = new Set(doubleKeys(agentTest));
    const stale = Object.keys(UNCOVERED_CONTEXT_METHODS).filter(
      (m) => provided.has(m) && !UNCOVERED_CONTEXT_METHODS[m].startsWith("present in the double"),
    );
    // Записи «present in the double» — напоминание, а не оправдание; они не
    // считаются протухшими, но и не должны молча разрастаться.
    expect(
      stale,
      `UNCOVERED_CONTEXT_METHODS lists methods the double already provides:\n${stale.join("\n")}`,
    ).toEqual([]);
  });

  it("gives every gap entry a real reason", () => {
    const weak = Object.entries(UNCOVERED_CONTEXT_METHODS)
      .filter(([, why]) => why.trim().length < 20)
      .map(([m]) => m);
    expect(weak, `Gap entries without a reason:\n${weak.join("\n")}`).toEqual([]);
  });

  it("keeps the unsafe-cast count in tests/core at or below its baseline", () => {
    // Baseline 138 — зафиксирован 2026-10-15 после снятия кастов в этой волне
    // (было 193). Число 192 из плана получено `git grep -c`, который считает
    // СТРОКИ, а не вхождения; здесь считаются именно вхождения, потому что
    // каждое из них отключает проверку.
    const BASELINE = 138;
    const now = countUnsafeCasts(TESTS_ROOT);
    expect(
      now,
      `Unsafe casts in tests/core grew past the baseline (${BASELINE}): now ${now}. ` +
        `A cast is a place the compiler stopped checking the test — each new one ` +
        `should be argued for, not defaulted into.`,
    ).toBeLessThanOrEqual(BASELINE);
  });

  it("every seam test names a paired test on the real path", () => {
    const unpaired = SEAM_COVERAGE.filter((s) => !s.paired).map((s) => `${s.file} (${s.seam})`);
    expect(
      unpaired,
      `Seam tests with no paired test on the real path. A seam replaces the code under ` +
        `test, so without a counterpart the real path is never exercised:\n${unpaired.join("\n")}`,
    ).toEqual([]);
  });

  it("every seam entry points at a test file that exists", () => {
    const missing = SEAM_COVERAGE.map((s) => ({
      seam: s.seam,
      // Путь идёт первым в поле `where` — вытаскиваем его по началу строки,
      // чтобы кириллица в пояснении не влияла на разбор.
      path: s.where.trim().split(/\s/)[0].replace(/[.,;:)]+$/, ""),
    })).filter(({ path }) => {
      if (!path.startsWith("tests/")) return true;
      try {
        readFileSync(resolve(REPO_ROOT, path), "utf-8");
        return false;
      } catch {
        return true;
      }
    }).map((s) => `${s.seam} → ${s.path}`);
    expect(missing, `Seam entries pointing at a non-existent test:\n${missing.join("\n")}`).toEqual([]);
  });

  it("scanner sees a method the real class has and the double lacks", () => {
    const real = contextManagerMethods("class X {\n  alpha() {}\n  beta() {}\n  get gamma() {\n    return 1;\n  }\n}\n");
    const provided = new Set(["alpha"]);
    expect(real.filter((m) => !provided.has(m))).toEqual(["beta", "gamma"]);
  });
});