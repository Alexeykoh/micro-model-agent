// Запуск stdio-сервера MCP: Windows-шим (`npx` → `npx.cmd`) и среда из конфига.
// Вынесено из `client.ts` (правило ≤300): клиент — протокол, не про spawn.
import { spawn, type ChildProcess } from "child_process";
import type { MCPServerConfig } from "./registry";
import { spawnSpec } from "../../utils/spawn-command";
import { killTree } from "../processes/kill-tree";

/**
 * Какое значение PATH отдавать резолву шима.
 *
 * Явный `env` из конфига главнее процесса. В остальном на Windows `Path`
 * приоритетнее `PATH`: под git-bash/MSYS `PATH` приходит в POSIX-форме
 * (`/c/…:/usr/bin`), и `resolveSpawnCommand` (он делит строку по `;`) не находит
 * в ней `.cmd`-шим — ровно тот дефект, который чинил spawn-command. В env-блоке
 * Windows оба ключа несут одну переменную, поэтому `Path` — исходная форма.
 */
export function spawnEnvPath(
  env: NodeJS.ProcessEnv,
  override: NodeJS.ProcessEnv | undefined,
  platformName: string,
): string {
  const explicit = override?.PATH ?? override?.Path;
  if (explicit) return explicit;
  return platformName === "win32"
    ? env.Path ?? env.PATH ?? ""
    : env.PATH ?? env.Path ?? "";
}

/**
 * Спавн MCP-сервера. Голое имя (`npx`, `npm`) на Windows — это `.cmd`-шим,
 * который `spawn` не находит (ENOENT) и не запускает без shell (EINVAL):
 * резолв и `shell: true` делает `spawnSpec`.
 */
export function spawnMcpServer(config: MCPServerConfig): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, ...config.env };
  const spec = spawnSpec(
    config.command!,
    config.args || [],
    undefined,
    spawnEnvPath(env, config.env, process.platform),
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
