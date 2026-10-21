// Дедупликация фоновых процессов: ключ «сессия + cwd + нормализованная команда».
// Вынесено из `registry.ts` — чистые функции, без состояния реестра.
import type { ManagedProcess } from "./registry";

/** Ключ дедупликации: сессия, рабочий каталог и нормализованная команда. */
export function dedupeKey(command: string, cwd: string, sessionId?: string): string {
  return `${sessionId ?? ""}\u0000${cwd}\u0000${command.trim().replace(/\s+/g, " ")}`;
}

/** Ищет уже бегущий процесс с тем же ключом среди кандидатов. */
export function findRunning(
  candidates: Iterable<ManagedProcess>,
  command: string,
  cwd: string,
  sessionId?: string,
): ManagedProcess | null {
  const key = dedupeKey(command, cwd, sessionId);
  for (const p of candidates) {
    if (p.status === "running" && dedupeKey(p.command, p.cwd, p.sessionId) === key) {
      return p;
    }
  }
  return null;
}
