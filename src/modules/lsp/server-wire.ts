// Спавн процесса сервера и подписка на его события.
//
// Вынесено из `connection.ts` (правило 6): это обвязка процесса, а не логика
// соединения.
import type { LaunchPlan, ServerProcess, ServerProcessFactory } from "./connection-types";

export interface ServerProcessHandlers {
  onExit: (proc: ServerProcess, code?: number | null, signal?: string | null) => void;
  onError: (error: Error) => void;
  onStdout: (chunk: Buffer) => void;
  stderr: (chunk: string) => void;
}

/**
 * Поднять процесс и подписать его на события (exit/error/stdout/stderr).
 * `onSpawn` вызывается до подписки — соединение успевает записать процесс.
 */
export async function spawnAndWireProcess(
  spawn: ServerProcessFactory,
  plan: LaunchPlan,
  cwd: string,
  handlers: ServerProcessHandlers,
  onSpawn: (proc: ServerProcess) => void,
): Promise<void> {
  const proc = await spawn(plan, cwd);
  onSpawn(proc);
  proc.once("exit", (code, signal) => handlers.onExit(proc, code, signal));
  proc.on("error", handlers.onError);
  if (proc.stderr) {
    // stderr сервера ЧИТАЕМ: иначе «болтливый» сервер (npm-предупреждения,
    // краш-логи) забивает пайп и встаёт (аудит §8.2).
    proc.stderr.on("data", (chunk: Buffer) => handlers.stderr(chunk.toString()));
  }
  if (proc.stdout) proc.stdout.on("data", handlers.onStdout);
}
