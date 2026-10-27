import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Gate: правила стиля либо под гвардом, либо объявлены долгом (W12).
 *
 * `docs/agents/code-style.md` — нормативный документ, но у половины его правил
 * нет проверки: правило без гварда живёт до следующего крупного изменения
 * (AGENTS правило 5). Гейт требует, чтобы КАЖДЫЙ раздел документа был либо
 * привязан к тесту, либо явно отложен с причиной — как реестр долгов, только
 * для стиля. Плюс три конкретных счётчика, у которых гварда не было:
 *
 *   1. `as any` / `as unknown as` в `src/` — baseline, только уменьшается;
 *   2. `as unknown as *Host` в `src/core/agent.ts` — НЕ запрещены, а объявлены:
 *      это мутабельные живые виды `Agent` (фаза пишет поля обратно), литерал их
 *      бы скопировал и потерял запись. Объявлять надо именно поэтому;
 *   3. пустых `catch {}` / `.catch(() => {})` — бюджет на файл, новый провал
 *      сверх бюджета краснеет.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const STYLE_DOC = join(REPO_ROOT, "docs", "agents", "code-style.md");
const AGENT_TS = join(REPO_ROOT, "src", "core", "agent.ts");
const SRC = join(REPO_ROOT, "src");

/**
 * Раздел документа → гвард или долг. `guard` — файл теста и якорь в нём;
 * `baseline` — причина, почему проверки нет.
 */
export const STYLE_RULES: Array<
  | { heading: string; guard: { file: string; anchor: string } }
  | { heading: string; baseline: string }
> = [
  { heading: "Форматирование", guard: { file: "package.json", anchor: "format:check" } },
  { heading: "Типизация", guard: { file: "tests/arch/double-honesty.test.ts", anchor: "countUnsafeCasts" } },
  {
    heading: "Постепенное ужесточение tsconfig",
    baseline: "флаги tsconfig включаются по одному, отдельными PATCH — не проверяются гейтом",
  },
  {
    heading: "Асинхронность",
    baseline: "прерываемость await и таймауты сетевых/дочерних процессов не проверяются автоматически",
  },
  { heading: "Обработка ошибок", guard: { file: "tests/arch/style-rules.test.ts", anchor: "SILENT_CATCH_RE" } },
  {
    heading: "Порядок в файле",
    baseline: "порядок секций не проверяется автоматически — только ревью",
  },
  { heading: "Именование", guard: { file: "tests/arch/style-rules.test.ts", anchor: "KEBAB_RE" } },
  { heading: "Пользовательские строки", guard: { file: "tests/i18n.test.ts", anchor: "ru" } },
];

/**
 * Объявленные `as unknown as *Host` в `src/core/agent.ts`, по имени фазовой
 * функции на той же строке. Не «мигают», потому что уронить их нельзя.
 */
export const HOST_CASTS: Record<string, string> = {
  phaseBuildSystemPrompt:
    "PromptPhaseHost: мутабельный вид — фаза пишет overflowHintBlock обратно в Agent",
  phaseLogContextStat: "PromptPhaseHost: тот же живой вид, копия потеряла бы запись",
  phaseGetSystemPromptInfo: "PromptPhaseHost: читает promptOverrides живого Agent",
  phaseResolvePromptOverflowOnce:
    "PromptPhaseHost: пишет overflowHintBlock/promptOverrides обратно — литерал не годится",
  phaseRefreshSystemPrompt: "PromptPhaseHost: сбрасывает systemPromptAdded живого Agent",
  runTurn:
    "TurnRunHost: фаза пишет shutdownRequested/abortController/systemPromptAdded/overflowResolved/probePassed обратно",
  phaseReconfigure: "ProviderPhaseHost: пишет lastProbeIdentity/probePassed обратно в Agent",
  phaseSetProvider: "ProviderPhaseHost: тот же живой вид с обратной записью",
  phaseListProviders: "ProviderPhaseHost: читает живой deps/costTracker Agent",
  phaseGetProviderFor: "ProviderPhaseHost: читает живой deps Agent",
};

/** Пустые `catch {}` / `.catch(() => {})` / `.catch(() => null)` на файл: бюджет, не список строк. */
export const SILENT_CATCHES: Record<string, { count: number; reason: string }> = {
  "src/cli/repl.ts": { count: 3, reason: "fire-and-forget запись/обновление REPL, ошибка не actionable" },
  "src/core/hallucination/llm-judge.ts": { count: 1, reason: "эталон: consume-канал судьи, причина в комментарии рядом" },
  "src/core/bootstrap/session-runner.ts": { count: 1, reason: "best-effort фоновая проба, сессия уже поднята" },
  "src/core/bootstrap/session-phase.ts": { count: 1, reason: "best-effort фоновая операция bootstrap" },
  "src/core/bootstrap/agent-phase.ts": { count: 1, reason: "best-effort фоновая операция bootstrap" },
  "src/modules/browser/driver.ts": { count: 7, reason: "teardown браузера (page/context/browser.close) — best-effort" },
  "src/modules/indexer/module.ts": { count: 2, reason: "фоновая перестройка индекса, ошибка видна из других сигналов" },
  "src/modules/critic/client.ts": { count: 3, reason: "гонка дедлайна: гасим вторичные reject проигравших промисов, причина таймаута уже в critic_degraded" },
  "src/core/agent/turn-run.ts": { count: 1, reason: "фоновая запись, не блокирует ход" },
  "src/tools/mcp-call.ts": { count: 1, reason: "disconnect MCP-клиента при уборке — best-effort" },
  "src/modules/mcp/module.ts": { count: 1, reason: "disconnect MCP-клиента при уборке — best-effort" },
  "src/modules/webui/chat/actions-api.ts": { count: 2, reason: "UI: команда/индексация fire-and-forget, ошибка не блокирует чат" },
  "src/modules/webui/assets/js/sidebar/plugins.ts": { count: 1, reason: "UI: запись в clipboard best-effort" },
  "src/modules/webui/assets/js/sidebar/lsp.ts": { count: 1, reason: "UI: запись в clipboard best-effort" },
  "src/modules/lsp/check-tool.ts": { count: 1, reason: "проба существования пути — отсутствие файла нормальный результат" },
  "src/modules/lsp/check-run.ts": { count: 1, reason: "прогрев fail-open: отказ старта сервера не должен ломать саму проверку" },
  "src/modules/lsp/connection.ts": { count: 1, reason: "best-effort запрос диагностики, сервер может не ответить" },
  "src/modules/updater/install-release.ts": {
    count: 2,
    reason: "teardown после flip (tmp и отброшенный ярлык): установка применена, ошибка уборки не actionable",
  },
  "src/modules/updater/factory.ts": {
    count: 1,
    reason: "фоновая уборка каталогов прошлых версий на старте — best-effort, не блокирует запуск",
  },
};

const CAST_RE = /\bas any\b|\bas unknown as\b/g;
const HOST_CAST_RE = /\b(\w+)\(\s*this as unknown as \w+Host/g;
const SILENT_CATCH_RE =
  /\.catch\(\s*\(\s*\)\s*=>\s*(?:\{\s*\}|null|undefined)\s*\)|catch\s*(?:\(\s*\w*\s*\))?\s*\{\s*\}/g;
/** Имена файлов — kebab-case (раздел «Именование» в code-style.md). */
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.tsx?$/;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      walk(join(dir, entry.name), out);
      continue;
    }
    if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(join(dir, entry.name));
  }
}

/** Считает вхождения регулярки в исходнике (экспорт — для позитивного контроля). */
export function countMatches(source: string, re: RegExp): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(source) !== null) n++;
  return n;
}

describe("gate: style rules have a guard or a declared reason (W12)", () => {
  const srcFiles: string[] = [];
  walk(SRC, srcFiles);

  it("every section of code-style.md is declared (no rule without a guard or a reason)", () => {
    const doc = readFileSync(STYLE_DOC, "utf-8");
    const headings = [...doc.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
    const declared = new Set(STYLE_RULES.map((r) => r.heading));
    const missing = headings.filter((h) => !declared.has(h));
    expect(missing, `Раздел без гварда и без записи: ${missing.join(", ")}`).toEqual([]);
    const extra = [...declared].filter((h) => !headings.includes(h));
    expect(extra, `Запись для несуществующего раздела: ${extra.join(", ")}`).toEqual([]);
  });

  it("every guard rule resolves to a real test that names it, and every baseline has a reason", () => {
    for (const rule of STYLE_RULES) {
      if ("guard" in rule) {
        const text = readFileSync(join(REPO_ROOT, rule.guard.file), "utf-8");
        expect(text, `${rule.heading}: ${rule.guard.file} не содержит якорь`).toContain(
          rule.guard.anchor,
        );
      } else {
        expect(
          rule.baseline.trim().length,
          `${rule.heading}: причина слишком короткая`,
        ).toBeGreaterThan(20);
      }
    }
  });

  it("counts casts in a fixture (positive control, so the counters are not vacuous)", () => {
    expect(countMatches("const a = x as any; const b = y as unknown as Z;", CAST_RE)).toBe(2);
    expect(countMatches("runTurn(this as unknown as TurnRunHost, input);", HOST_CAST_RE)).toBe(1);
    expect(countMatches("foo().catch(() => {});", SILENT_CATCH_RE)).toBe(1);
    expect(countMatches("try {} catch {}", SILENT_CATCH_RE)).toBe(1);
  });

  it("unsafe casts in src/ stay at or below the baseline", () => {
    // Baseline 36 — зафиксирован 2026-10-15 (W12). Счётчик `as any` не
    // дублируется: тестовый — в `double-honesty.test.ts` (W9.2), этот — `src`.
    const BASELINE = 36;
    const now = srcFiles.reduce(
      (n, f) => n + countMatches(readFileSync(f, "utf-8"), CAST_RE),
      0,
    );
    expect(
      now,
      `Кастов в src/ стало больше baseline (${BASELINE}): ${now}. Замени каст на narrowing/` +
        `satisfies/тип, либо обоснуй и подними baseline осознанно.`,
    ).toBeLessThanOrEqual(BASELINE);
  });

  it("every `as unknown as *Host` in agent.ts is declared with a reason", () => {
    const found = new Set(
      [...readFileSync(AGENT_TS, "utf-8").matchAll(HOST_CAST_RE)].map((m) => m[1]),
    );
    const undeclared = [...found].filter((name) => !(name in HOST_CASTS));
    expect(
      undeclared,
      `Живой вид хоста без объявления. Это мутабельные швы: литерал скопировал бы ` +
        `поля и потерял обратную запись. Объяви причину в HOST_CASTS:\n${undeclared.join("\n")}`,
    ).toEqual([]);
    const stale = Object.keys(HOST_CASTS).filter((name) => !found.has(name));
    expect(stale, `Объявление без каста (фаза переименована/убрана): ${stale.join(", ")}`).toEqual([]);
    for (const [name, reason] of Object.entries(HOST_CASTS)) {
      expect(reason.trim().length, `${name}: причина слишком короткая`).toBeGreaterThan(20);
    }
  });

  it("silent catches keep to their per-file budget", () => {
    for (const file of srcFiles) {
      const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
      const n = countMatches(readFileSync(file, "utf-8"), SILENT_CATCH_RE);
      if (n === 0) continue;
      const declared = SILENT_CATCHES[rel];
      expect(
        declared,
        `Молчаливый catch в ${rel} (${n} шт.) не объявлен: добавь бюджет с причиной ` +
          `в SILENT_CATCHES или логируй ошибку (правило #14).`,
      ).toBeDefined();
      expect(
        n,
        `${rel}: молчаливых catch стало ${n}, объявлено ${declared.count}. ` +
          `Новый молчаливый отказ — это регресс наблюдаемости (правило #14).`,
      ).toBeLessThanOrEqual(declared.count);
      expect(declared.reason.trim().length, `${rel}: причина слишком короткая`).toBeGreaterThan(20);
    }
    const staleBudget = Object.keys(SILENT_CATCHES).filter(
      (rel) => countMatches(readFileSync(join(REPO_ROOT, rel), "utf-8"), SILENT_CATCH_RE) === 0,
    );
    expect(staleBudget, `Бюджет объявляет файл без молчаливых catch: ${staleBudget.join(", ")}`).toEqual([]);
  });

  it("source file names are kebab-case (Именование)", () => {
    const bad = srcFiles
      .map((f) => relative(SRC, f).replace(/\\/g, "/").split("/").pop() ?? "")
      .filter((name) => !KEBAB_RE.test(name));
    expect(bad, `Не kebab-case (раздел «Именование»): ${bad.join(", ")}`).toEqual([]);
  });
});
