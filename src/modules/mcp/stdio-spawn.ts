// Запуск stdio-сервера MCP: Windows-шим (`npx` → `npx.cmd`) и среда из конфига.
// Вынесено из `client.ts` (правило ≤300): клиент — протокол, не про spawn.
import { spawn, type ChildProcess } from "child_process";
import type { MCPServerConfig } from "./registry";
import { spawnSpec } from "../../utils/spawn-command";
import { killTree } from "../processes/kill-tree";

/**
 * Спавн MCP-сервера. Голое имя (`npx`, `npm`) на Windows — это `.cmd`-шим,
 * который `spawn` не находит (ENOENT) и не запускает без shell (EINVAL):
 * резолв и `shell: true` делает `spawnSpec`.
 */
export function spawnMcpServer(config: MCPServerConfig): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, ...config.env };
  // В env-объекте Windows ключ приходит как `Path` — `env.PATH` тогда
  // undefined, и резолв шима молча выключается.
  const spec = spawnSpec(
    config.command!,
    config.args || [],
    undefined,
    env.PATH ?? env.Path ?? "",
  );
  return spawn(spec.command, spec.args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(spec.shell ? { shell: true } : {}),
  });
}

/**
 * Остановить MCP-сервер. Через shell это `cmd.exe → npx → node`: `kill()` бьёт
 * только оболочку и оставляет сервер (и Chrome) сиротой, поэтому — killTree.
 */
export function stopMcpServer(proc: ChildProcess): void {
  killTree(proc);
}
