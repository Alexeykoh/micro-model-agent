/**
 * Порядок инициализации модулей и ошибка жизненного цикла. Вынесено из
 * `module-host.ts` (правило ≤300/AGENTS правило 6): хост держит реестр, сбор и
 * lifecycle, а топологическая сортировка по `requires` — отдельная деталь.
 */
import type { ModuleDef } from "./module-host";

/** Ошибка жизненного цикла: неизвестная зависимость, цикл, падение critical. */
export class ModuleHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModuleHostError";
  }
}

/**
 * Топологическая сортировка по `requires` (Kahn). Бросает на неизвестную
 * зависимость и на цикл — молча неправильный порядок хуже явной ошибки.
 */
export function topoSort(defs: ReadonlyMap<string, ModuleDef>): string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const name of defs.keys()) {
    indegree.set(name, 0);
    dependents.set(name, []);
  }
  for (const [name, def] of defs) {
    for (const req of def.requires ?? []) {
      if (!defs.has(req)) {
        throw new ModuleHostError(`module "${name}" requires unknown module "${req}"`);
      }
      indegree.set(name, (indegree.get(name) ?? 0) + 1);
      dependents.get(req)!.push(name);
    }
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([n]) => n);
  const order: string[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    order.push(name);
    for (const next of dependents.get(name)!) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (order.length !== defs.size) {
    throw new ModuleHostError("module requires form a cycle");
  }
  return order;
}
