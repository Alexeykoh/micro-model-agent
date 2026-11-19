// Реестр фоновых детей процесса.
//
// Некоторые проверки (например, стартовый `tsc --noEmit`) спавнятся через
// shell, и после выхода MMA процесс-потомок оставался жить: `cmd.exe` умирал,
// а `tsc` — нет (аудит §7.10). Реестр даёт одно место, где дети гасятся при
// выходе процесса.
import type { ChildProcess } from "node:child_process";
import { killTree } from "./kill-tree";

/** Зарегистрированные фоновые дети. */
const children = new Set<ChildProcess>();

let hooksInstalled = false;

/** Регистрирует фонового ребёнка (гасится при выходе процесса). */
export function registerBackgroundChild(child: ChildProcess): void {
  children.add(child);
  installHooks();
  child.once("close", () => children.delete(child));
}

/** Снимает ребёнка с учёта (он завершился сам). */
export function unregisterBackgroundChild(child: ChildProcess): void {
  children.delete(child);
}

/** Гасит всех зарегистрированных детей. */
export function killBackgroundChildren(): void {
  for (const child of children) {
    killTree(child);
  }
  children.clear();
}

/** Сколько детей в реестре (для тестов/диагностики). */
export function backgroundChildCount(): number {
  return children.size;
}

/** Вешает хуки выхода процесса (один раз). */
function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const kill = (): void => {
    killBackgroundChildren();
  };
  process.on("exit", kill);
  process.on("beforeExit", kill);
}
