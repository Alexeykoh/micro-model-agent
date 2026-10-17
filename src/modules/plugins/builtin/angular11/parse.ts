// Низкоуровневый разбор Angular-файлов плагина `angular11`: обход дерева,
// чтение inline-массивов, определение экспортируемого класса, текст шаблона.
// Вынесено из `analyze.ts` (правило ≤300). Чистые функции без состояния;
// типы берём из `analyze.ts` типовым импортом (стирается в рантайме — цикла нет).
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { ClassInfo, NgModuleInfo } from "./analyze";

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

/** Список элементов из `key: [a, b, c]` и признак того, что он разобран. */
function readArray(text: string, key: string): { items: string[]; resolved: boolean } {
  const direct = text.match(new RegExp(`${key}\\s*:\\s*\\[([\\s\\S]*?)\\]`));
  let raw: string | null = direct ? direct[1] : null;
  if (raw === null) {
    // Ключ задан переменной (`key: VAR`)? Тогда ищем её inline-массив в том же
    // файле (`const VAR = [a, b]`) — это типовой barrel-паттерн.
    const keyExpr = text.match(new RegExp(`\\b${key}\\s*:\\s*([A-Za-z_$][\\w$]*)`));
    if (!keyExpr) {
      const hasAnyKey = new RegExp(`\\b${key}\\s*:`).test(text);
      return { items: [], resolved: !hasAnyKey };
    }
    const varName = keyExpr[1];
    const constMatch = text.match(
      new RegExp(`\\b(?:const|let|var)\\s+${varName}\\s*=\\s*\\[([\\s\\S]*?)\\]`),
    );
    if (!constMatch) return { items: [], resolved: false };
    raw = constMatch[1];
  }
  const items = raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  // Спред (`...FOO`) означает, что часть элементов нам неизвестна.
  const resolved = !items.some((item) => item.startsWith("..."));
  return { items, resolved };
}

/**
 * Имя экспортируемого класса файла. Несколько `export class` в одном файле —
 * неоднозначность (декоратор не привязать к имени): возвращаем null, чтобы не
 * выдать ложный undeclared не тому классу.
 */
function classExport(content: string): string | null {
  const count = content.match(/export\s+class\s+[A-Za-z_$][\w$]*/g)?.length ?? 0;
  if (count !== 1) return null;
  const match = content.match(/export\s+class\s+([A-Za-z_$][\w$]*)/);
  return match ? match[1] : null;
}

/** Рекурсивный обход `.ts`/`.html` без захода в служебные каталоги. */
export function walk(root: string): string[] {
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
export const COMMON_TEMPLATE_RE =
  /\*(ngIf|ngFor|ngSwitch|ngSwitchCase|ngSwitchDefault)\b|\[(ngClass|ngStyle|ngSwitch)\]|\|\s*(async|date|json|uppercase|lowercase|slice|number|percent|currency|titlecase)\b/;

/** Текст шаблона компонента: inline `template` или файл `templateUrl`. */
export function templateOf(componentPath: string, content: string): string | null {
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
export function parseTs(
  relPath: string,
  content: string,
): { module?: NgModuleInfo; klass?: ClassInfo } {
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
