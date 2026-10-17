// Архитектурный анализ Angular-воркспейса (F2 плагина `angular11`).
//
// Дешёвый regex-обход без парсера: цель — поймать ошибки объявления/импорта,
// которые LSP и tsc не ловят (незадекларированный компонент, нет CommonModule
// в фиче, BrowserModule в ленивом модуле). Семантику типов и шаблонов не трогаем.
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, join, relative } from "path";
import { angularMajorVersion, findAngularRoot } from "./detect";

const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".angular",
  ".idea",
  ".vscode",
  "out",
  "coverage",
]);
const MAX_FILES = 4000;

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

/** Список элементов из `key: [a, b, c]` и признак того, что он разобран. */
function readArray(text: string, key: string): { items: string[]; resolved: boolean } {
  const match = text.match(new RegExp(`${key}\\s*:\\s*\\[([\\s\\S]*?)\\]`));
  if (!match) {
    // Ключа нет вовсе (нормально) или он задан не inline-массивом (`key: VAR`) — неразрешимо.
    const hasKey = new RegExp(`\\b${key}\\s*:`).test(text);
    return { items: [], resolved: !hasKey };
  }
  const items = match[1]
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  // Спред (`...FOO`) означает, что часть элементов нам неизвестна.
  const resolved = !items.some((item) => item.startsWith("..."));
  return { items, resolved };
}

/** Имя экспортируемого класса: `export class Foo`. */
function classExport(content: string): string | null {
  const match = content.match(/export\s+class\s+([A-Za-z_$][\w$]*)/);
  return match ? match[1] : null;
}

/** Рекурсивный обход `.ts`/`.html` без захода в служебные каталоги. */
function walk(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0 && files.length < MAX_FILES) {
    const dir = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (!IGNORE_DIRS.has(entry)) stack.push(full);
      } else if (entry.endsWith(".ts") || entry.endsWith(".html")) {
        files.push(full);
      }
    }
  }
  return files;
}

/** Разметка структурных директив и общих пайпов в шаблоне. */
const COMMON_TEMPLATE_RE =
  /\*(ngIf|ngFor|ngSwitch|ngSwitchCase|ngSwitchDefault)\b|\[(ngClass|ngStyle|ngSwitch)\]|\|\s*(async|date|json|uppercase|lowercase|slice|number|percent|currency|titlecase)\b/;

/** Текст шаблона компонента: inline `template` или файл `templateUrl`. */
function templateOf(componentPath: string, content: string): string | null {
  const inline = content.match(/template\s*:\s*`([\s\S]*?)`/);
  if (inline) return inline[1];
  const url = content.match(/templateUrl\s*:\s*['"`]([^'"`]+)['"`]/);
  if (url) {
    const htmlPath = join(componentPath, "..", url[1]);
    if (existsSync(htmlPath)) {
      try {
        return readFileSync(htmlPath, "utf-8");
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Разобрать один `.ts`-файл в модуль или класс. */
function parseTs(relPath: string, content: string): { module?: NgModuleInfo; klass?: ClassInfo } {
  const className = classExport(content);
  if (!className) return {};
  if (content.includes("@NgModule")) {
    const declarations = readArray(content, "declarations");
    const imports = readArray(content, "imports");
    const exports = readArray(content, "exports");
    return {
      module: {
        path: relPath,
        className,
        declarations: declarations.items,
        imports: imports.items,
        exports: exports.items,
        declarationsResolved: declarations.resolved,
        importsResolved: imports.resolved,
      },
    };
  }
  if (content.includes("@Component(")) {
    return { klass: { name: className, kind: "component", path: relPath } };
  }
  if (content.includes("@Directive(")) {
    return { klass: { name: className, kind: "directive", path: relPath } };
  }
  if (content.includes("@Pipe(")) {
    const impure = /pure\s*:\s*false/.test(content);
    return { klass: { name: className, kind: "pipe", path: relPath, impure } };
  }
  return {};
}

/** Собрать модули, классы и находки по воркспейсу. */
export function analyzeWorkspace(baseDir: string): Analysis {
  const root = findAngularRoot(baseDir) ?? baseDir;
  const files = walk(root);
  const modules: NgModuleInfo[] = [];
  const classes: ClassInfo[] = [];
  const byPath = new Map<string, string>();

  for (const file of files) {
    if (!file.endsWith(".ts")) continue;
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const rel = relative(root, file).replace(/\\/g, "/");
    byPath.set(rel, content);
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
