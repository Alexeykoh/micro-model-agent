// Архитектурный анализ Angular-воркспейса (F2 плагина `angular11`).
//
// Дешёвый regex-обход без парсера: цель — поймать ошибки объявления/импорта,
// которые LSP и tsc не ловят (незадекларированный компонент, нет CommonModule
// в фиче, BrowserModule в ленивом модуле), плюс семантику ссылок (мёртвый
// сервис, циклы модулей — `references.ts`). Низкоуровневый разбор — `parse.ts`.
// Семантику типов и шаблонов не трогаем.
import { readFileSync } from "fs";
import { basename, join, relative } from "path";
import { angularMajorVersion, findAngularRoot } from "./detect";
import { COMMON_TEMPLATE_RE, parseTs, templateOf, walk } from "./parse";
import { analyzeReferences } from "./references";
import { analyzeUsage } from "./usage";

/** NgModule и его метаданные в терминах `@NgModule({...})`. */
export interface NgModuleInfo {
  path: string;
  className: string;
  declarations: string[];
  imports: string[];
  exports: string[];
  /**
   * Разобраны ли `declarations` как inline-массив. `false` — значение задано
   * переменной/спредом (`declarations: COMPONENTS`, `[...A, B]`): тогда список
   * компонентов неизвестен, и проверку «класс не объявлен» запускать нельзя
   * (иначе — массовые ложные срабатывания).
   */
  declarationsResolved: boolean;
  /** Разобраны ли `imports` как inline-массив (та же причина, что у declarations). */
  importsResolved: boolean;
}

/** Класс-кандидат Angular (компонент/директива/пайп). */
export interface ClassInfo {
  name: string;
  kind: "component" | "directive" | "pipe";
  path: string;
  /** Для пайпов: `pure: false` в `@Pipe`. */
  impure?: boolean;
  /** Селектор компонента/директивы (`@Component({ selector })`). */
  selector?: string;
  /** Имя пайпа (`@Pipe({ name })`). */
  pipeName?: string;
}

/** Находка анализа. */
export interface Finding {
  severity: "error" | "warn";
  message: string;
}

/** Итог анализа воркспейса. */
export interface Analysis {
  root: string;
  major: number | null;
  modules: NgModuleInfo[];
  classes: ClassInfo[];
  findings: Finding[];
}

/** Собрать модули, классы и находки по воркспейсу. */
export function analyzeWorkspace(baseDir: string): Analysis {
  const root = findAngularRoot(baseDir) ?? baseDir;
  const files = walk(root);
  const modules: NgModuleInfo[] = [];
  const classes: ClassInfo[] = [];
  const byPath = new Map<string, string>();

  for (const file of files) {
    const isTs = file.endsWith(".ts");
    const isHtml = file.endsWith(".html");
    if (!isTs && !isHtml) continue;
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const rel = relative(root, file).replace(/\\/g, "/");
    // `.html` нужен слою использования (F6): селекторы компонентов живут в шаблонах.
    byPath.set(rel, content);
    if (!isTs) continue;
    // Спеки/тесты не задают прод-структуру: их `export class` — часто host-компоненты.
    if (/\.(spec|test)\.ts$/.test(rel)) continue;
    const parsed = parseTs(rel, content);
    if (parsed.module) modules.push(parsed.module);
    if (parsed.klass) classes.push(parsed.klass);
  }

  const findings: Finding[] = [];
  const declared = new Set<string>();
  for (const mod of modules) {
    for (const name of mod.declarations) declared.add(name);
  }

  // Если хоть один модуль задаёт declarations переменной/спредом, список
  // объявленных классов неполон — проверку «не объявлен» не запускаем вовсе.
  const declarationsComplete = modules.every((mod) => mod.declarationsResolved);

  for (const klass of classes) {
    if (declarationsComplete && !declared.has(klass.name)) {
      findings.push({
        severity: "error",
        message: `${klass.kind} "${klass.name}" (${klass.path}) is not declared in any NgModule`,
      });
    }
    if (klass.kind === "pipe" && klass.impure) {
      findings.push({
        severity: "warn",
        message: `pipe "${klass.name}" is impure (pure: false) — it runs on every change-detection cycle`,
      });
    }
  }

  // Модули, которые (транзитивно) реэкспортируют CommonModule: импорт любого из них
  // даёт общие директивы/пайпы, даже без прямого `imports: [CommonModule]`.
  const reexportsCommon = modulesReexportingCommon(modules);

  for (const mod of modules) {
    const isRoot = basename(mod.path) === "app.module.ts";
    if (mod.imports.includes("BrowserModule") && !isRoot) {
      findings.push({
        severity: "error",
        message: `BrowserModule is imported by feature module "${mod.className}" (${mod.path}) — only the root module may import it`,
      });
    }
    // imports заданы переменной — судить о наличии CommonModule нельзя.
    if (!mod.importsResolved) continue;
    const hasCommon =
      mod.imports.includes("BrowserModule") ||
      mod.imports.includes("CommonModule") ||
      mod.imports.some((name) => reexportsCommon.has(name));
    if (hasCommon) continue;
    // Фича использует общие директивы/пайпы в шаблоне, но не импортирует CommonModule.
    for (const name of mod.declarations) {
      const klass = classes.find((k) => k.name === name && k.kind === "component");
      if (!klass) continue;
      const content = byPath.get(klass.path);
      if (!content) continue;
      const tpl = templateOf(join(root, klass.path), content);
      if (tpl && COMMON_TEMPLATE_RE.test(tpl)) {
        findings.push({
          severity: "warn",
          message: `module "${mod.className}" uses common directives/pipes in "${klass.name}" templates but does not import CommonModule`,
        });
        break;
      }
    }
  }

  findings.push(...analyzeReferences(byPath, modules));
  findings.push(...analyzeUsage(classes, modules, byPath));

  return { root, major: angularMajorVersion(root), modules, classes, findings };
}

/** Собрать имена модулей, которые (транзитивно через `exports`) реэкспортируют CommonModule. */
function modulesReexportingCommon(modules: NgModuleInfo[]): Set<string> {
  const result = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const mod of modules) {
      if (result.has(mod.className)) continue;
      const exportsCommon =
        mod.exports.includes("CommonModule") || mod.exports.some((name) => result.has(name));
      if (exportsCommon) {
        result.add(mod.className);
        changed = true;
      }
    }
  }
  return result;
}
