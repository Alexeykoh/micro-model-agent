// Семантический слой плагина `angular11`: анализ ссылок между файлами
// (F5). В отличие от `analyze.ts` (структура NgModule), здесь строится
// примитивный граф «кто кого упоминает» — без TS-парсера, только по тексту.
//
// Что даёт рефакторингу/дебагу:
//   - мёртвый `@Injectable`-сервис (никем не импортирован/не инжектится);
//   - циклические импорты NgModule (A → B → A) — источник трудноуловимых
//     ошибок DI и «дыр» в ленивой загрузке.
// Границы осознанно консервативны: лучше пропустить, чем зашуметь (9B модель).
import { basename, dirname } from "path";
import type { Finding, NgModuleInfo } from "./analyze";

/** Сгенерированные/тестовые файлы не считаем определением прод-класса. */
const TEST_FILE_RE = /\.(spec|test)\.ts$/;

/** Первый экспортируемый класс файла (`export class Foo`). */
function firstExportClass(content: string): string | null {
  const match = content.match(/export\s+class\s+([A-Za-z_$][\w$]*)/);
  return match ? match[1] : null;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Достижим ли класс из других файлов. Учитываем три реальных паттерна Angular,
 * иначе получаем ложные «мёртвые» сервисы:
 *   1. имя класса упомянуто где-то ещё (прямой импорт/инъекция);
 *   2. другой файл импортирует этот по basename (`./foo.service`);
 *   3. другой файл импортирует barrel-каталог (`./_helpers`), а рядом лежит
 *      `index.ts` — тогда класс доступен через реэкспорт (кейс
 *      `FakeBackendInterceptor`, используемого через `fakeBackendProvider`).
 */
function isReachable(path: string, name: string, byPath: Map<string, string>): boolean {
  const base = basename(path).replace(/\.ts$/, "");
  const dir = basename(dirname(path));
  const hasBarrel = byPath.has(`${dirname(path).replace(/\\/g, "/")}/index.ts`);
  const nameRe = new RegExp(`\\b${escapeRe(name)}\\b`);
  const baseRe = new RegExp(`[/'"\`]${escapeRe(base)}['"\`]`);
  const dirRe = new RegExp(`[/'"\`]${escapeRe(dir)}['"\`]`);
  for (const [other, text] of byPath) {
    if (other === path) continue;
    if (nameRe.test(text) || baseRe.test(text)) return true;
    if (hasBarrel && dirRe.test(text)) return true;
  }
  return false;
}

/** Поиск циклов в ориентированном графе (DFS, рекурсивный стек). */
function findCycles(edges: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();

  const visit = (node: string): void => {
    if (onStack.has(node)) {
      const start = stack.indexOf(node);
      const cycle = stack.slice(start);
      // Нормализуем (сдвиг к минимальному имени) и дедуплицируем.
      const min = cycle.reduce((a, b) => (a < b ? a : b));
      const at = cycle.indexOf(min);
      const key = [...cycle.slice(at), ...cycle.slice(0, at)].join("→");
      if (!seen.has(key)) {
        seen.add(key);
        cycles.push([...cycle.slice(at), ...cycle.slice(0, at), min]);
      }
      return;
    }
    if (stack.includes(node)) return;
    onStack.add(node);
    stack.push(node);
    for (const next of edges.get(node) ?? []) visit(next);
    stack.pop();
    onStack.delete(node);
  };

  for (const node of edges.keys()) if (!stack.includes(node)) visit(node);
  return cycles;
}

/**
 * Найти мёртвые сервисы и циклы модулей по содержимому воркспейса.
 * @param byPath относительный путь → содержимое (все `.ts` воркспейса).
 * @param modules разобранные NgModule (для графа импортов).
 */
export function analyzeReferences(
  byPath: Map<string, string>,
  modules: NgModuleInfo[],
): Finding[] {
  const findings: Finding[] = [];
  const all = [...byPath.entries()];

  // ---- мёртвый сервис: `@Injectable`, недостижимый ни из одного другого файла ----
  for (const [path, content] of all) {
    if (TEST_FILE_RE.test(path)) continue;
    if (!content.includes("@Injectable(")) continue;
    const name = firstExportClass(content);
    if (!name) continue;
    // Спеки тоже учитываем: покрытый тестом сервис не считаем мёртвым.
    if (isReachable(path, name, byPath)) continue;
    findings.push({
      severity: "warn",
      message: `service "${name}" (${path}) is not imported or injected anywhere — possible dead code`,
    });
  }

  // ---- циклические импорты NgModule ----
  const moduleNames = new Set(modules.map((m) => m.className));
  const edges = new Map<string, string[]>();
  for (const mod of modules) {
    edges.set(
      mod.className,
      mod.imports.filter((name) => moduleNames.has(name) && name !== mod.className),
    );
  }
  for (const cycle of findCycles(edges)) {
    findings.push({
      severity: "error",
      message: `circular NgModule imports: ${cycle.join(" → ")}`,
    });
  }

  return findings;
}
