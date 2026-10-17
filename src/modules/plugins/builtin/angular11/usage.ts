// Использование компонентов/директив/пайпов (F6, W7 плагина `angular11`).
//
// Отвечает на вопрос рефакторинга «этот компонент/директива/пайп ещё жив?» без
// TS-парсера — по селектору в шаблонах, по имени пайпа и по упоминанию класса
// вне списков объявления.
//
// Консервативно, чтобы не шуметь у 9B-модели:
//   - публичный API (класс в `exports` любого модуля) не считается мёртвым;
//   - класс, которого нет ни в одном `declarations` (не объявлен), не трогаем —
//     это дефект слоя F2 («not declared»), а не «мёртвый код»;
//   - содержимое `declarations/exports/imports` маскируется перед поиском
//     упоминания класса: перечисление ≠ использование. Поэтому `bootstrap: [...]`
//     и `component: X` в маршрутах остаются и считаются использованием.
import type { ClassInfo, Finding, NgModuleInfo } from "./analyze";

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Скрыть то, что не является использованием класса: содержимое
 * `declarations/exports/imports` (перечисление) и строки `import/export ... from`.
 * Тогда `bootstrap: [X]` и `component: X` в маршрутах остаются как использование.
 */
function masked(text: string): string {
  return text
    .replace(/\b(declarations|exports|imports)\s*:\s*\[[^\]]*\]/g, "$1: []")
    .replace(/\bimport\b[^;]*?from\s*['"][^'"]+['"]/g, "/*import*/")
    .replace(/\bexport\b[^;]*?from\s*['"][^'"]+['"]/g, "/*export*/");
}

/** Токены селектора: `app-x`, `app-x, [appX]`, `.cls` → [app-x, appX, cls]. */
function selectorTokens(selector: string): string[] {
  return selector
    .split(",")
    .map((part) =>
      part
        .trim()
        .replace(/^\[|\]$/g, "")
        .replace(/^\./, "")
        .trim(),
    )
    .filter(Boolean);
}

/** Найти классы, которые объявлены, но не используются ни по селектору, ни по классу. */
export function analyzeUsage(
  classes: ClassInfo[],
  modules: NgModuleInfo[],
  byPath: Map<string, string>,
): Finding[] {
  const exported = new Set<string>();
  const declared = new Set<string>();
  for (const mod of modules) {
    for (const name of mod.exports) exported.add(name);
    for (const name of mod.declarations) declared.add(name);
  }

  const files = [...byPath.entries()];
  const usedAnywhere = (token: string, ownPath: string): boolean => {
    const re = new RegExp(`\\b${escapeRe(token)}\\b`);
    return files.some(([path, text]) => path !== ownPath && re.test(masked(text)));
  };

  const findings: Finding[] = [];
  for (const klass of classes) {
    // Публичный API модуля или не объявленный класс — не наша забота.
    if (exported.has(klass.name) || !declared.has(klass.name)) continue;
    const tokens =
      klass.kind === "pipe"
        ? klass.pipeName
          ? [klass.pipeName]
          : []
        : klass.selector
          ? selectorTokens(klass.selector)
          : [];
    // Нет селектора/имени — судить не можем.
    if (tokens.length === 0) continue;
    const used = tokens.some((t) => usedAnywhere(t, klass.path)) || usedAnywhere(klass.name, klass.path);
    if (used) continue;
    const how =
      klass.kind === "pipe" ? `pipe "| ${klass.pipeName}"` : `selector "${klass.selector}"`;
    findings.push({
      severity: "warn",
      message: `${klass.kind} "${klass.name}" (${klass.path}) looks unused — ${how} is used in no template and the class is never referenced`,
    });
  }
  return findings;
}
