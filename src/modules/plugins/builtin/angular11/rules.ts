// Реестр идиомных правил Angular 11 для проверки при записи (F3 плагина `angular11`).
//
// Только архитектурные идиомы эпохи classic-NgModule: API из 14+/16+/17+, которых
// в 11 нет, и типовые промахи. Семантику типов и шаблонов не проверяем — это LSP.
// Реестр расширяемый: правило = regex + сообщение; спецслучаи — кодом.
import type { Finding } from "./analyze";

/** Правило-регексп: к каким расширениям применяется и что сообщает. */
interface RegexRule {
  pattern: RegExp;
  message: string;
  severity: "error" | "warn";
}

/** API 14+, которых нет в Angular 11. */
const TS_RULES: RegexRule[] = [
  {
    pattern: /\bstandalone\s*:\s*(true|false)/,
    message: "`standalone` does not exist in Angular 11 (added in 14). Declare the class in an NgModule instead.",
    severity: "error",
  },
  {
    pattern: /\btakeUntilDestroyed\b/,
    message: "`takeUntilDestroyed` does not exist in Angular 11 (added in 16). Use a `destroy$` subject + `takeUntil`.",
    severity: "error",
  },
  {
    pattern: /\bprovide(Router|HttpClient|Animations|ZoneChangeDetection)\s*\(/,
    message: "functional providers (`provideRouter`/`provideHttpClient`/…) are 14+. Import the NgModule (`RouterModule.forRoot`, `HttpClientModule`) instead.",
    severity: "error",
  },
  {
    pattern: /(?<!@)\bviewChild(ren)?\s*\(|(?<!@)\bcontentChild(ren)?\s*\(/,
    message: "signal queries (`viewChild`/`contentChild`) are 17+. Use the `@ViewChild`/`@ContentChild` decorators.",
    severity: "error",
  },
  {
    pattern: /\brequired\s*:\s*true\b/,
    message: "`@Input({ required: true })` is 16+. Mark the input as required in the type/maintainer docs instead.",
    severity: "error",
  },
];

/** Импорт из `@angular/core` API 14+/17+ (по именам). */
const CORE_IMPORT_RE =
  /import\s*\{([^}]*)\}\s*from\s*['"]@angular\/core['"]/g;
const CORE_MODERN_NAMES = new Set([
  "signal",
  "computed",
  "effect",
  "input",
  "output",
  "model",
  "inject",
  "takeUntilDestroyed",
]);

/** Новый control-flow синтаксис шаблонов (17+). */
const HTML_RULES: RegexRule[] = [
  {
    pattern: /(^|[^\w])@(if|for|switch)\s*[({]/,
    message: "`@if`/`@for`/`@switch` control flow is 17+. Use `*ngIf`/`*ngFor`/`*ngSwitch` (import `CommonModule`).",
    severity: "error",
  },
];

/** Правила, применённые к тексту файла: находки по строкам. */
function applyRules(ext: ".ts" | ".html", content: string): Finding[] {
  const rules = ext === ".ts" ? TS_RULES : HTML_RULES;
  const findings: Finding[] = [];
  for (const rule of rules) {
    if (rule.pattern.test(content)) {
      findings.push({ severity: rule.severity, message: rule.message });
    }
  }
  return findings;
}

/** Встречается ли в файле импорт modern-API из `@angular/core`. */
function hasModernCoreImport(content: string): boolean {
  CORE_IMPORT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CORE_IMPORT_RE.exec(content)) !== null) {
    const names = match[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim());
    if (names.some((n) => CORE_MODERN_NAMES.has(n))) return true;
  }
  return false;
}

/** Операторы, которые сами завершают подписку — отписка/`ngOnDestroy` не нужны. */
const SELF_COMPLETING_RE = /\b(first|take)\s*\(\s*(1\s*)?\)/;

/**
 * Проверить содержимое записанного файла на идиомы Angular 11.
 * Пусто — файл чист (или расширение не наше).
 */
export function checkContent(ext: ".ts" | ".html", content: string): Finding[] {
  const findings = applyRules(ext, content);
  if (ext === ".ts" && hasModernCoreImport(content)) {
    findings.push({
      severity: "error",
      message: "imports a 14+/17+ API from `@angular/core` (signal/effect/inject/input/output/model) — not available in Angular 11.",
    });
  }
  // Warn: подписка в компоненте без отписки (нет ngOnDestroy) и без само-завершения
  // (`first()`/`take(1)` завершают поток сами — как в типовых HTTP-запросах).
  if (
    ext === ".ts" &&
    /@Component\(/.test(content) &&
    /\.subscribe\s*\(/.test(content) &&
    !/ngOnDestroy\s*\(/.test(content) &&
    !SELF_COMPLETING_RE.test(content)
  ) {
    findings.push({
      severity: "warn",
      message: "`.subscribe(...)` in a component without `ngOnDestroy` — a possible subscription leak (use the `async` pipe or unsubscribe via `takeUntil`).",
    });
  }
  return findings;
}
