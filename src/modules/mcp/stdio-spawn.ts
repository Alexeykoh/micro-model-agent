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
 * приоритетнее `PATH`: под git-bash/MSYS `PATH` бывает в POSIX-форме
 * (`/c/…:/usr/bin`), и `resolveSpawnCommand` (он делит строку по `;`) не
 * находит `.cmd`-шим в такой строке.
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
 * Среда для спавна + выбранный PATH.
 *
 * В env-блоке Windows `PATH` и `Path` — одна переменная. Если оставить оба ключа
 * (обычное дело под git-bash: `PATH` от bash + `Path` от системы/конфига),
 * `cmd.exe` может взять первую запись — без каталога шима, и получит
 * «не является внутренней или внешней командой». Поэтому на Windows оставляем
 * ровно один ключ с выбранным значением; на прочих платформах не трогаем.
 */
export function spawnEnv(
  mergedEnv: NodeJS.ProcessEnv,
  override: NodeJS.ProcessEnv | undefined,
  platformName: string,
): { env: NodeJS.ProcessEnv; pathEnv: string } {
  const env: NodeJS.ProcessEnv = { ...mergedEnv };
  const pathEnv = spawnEnvPath(env, override, platformName);
  if (platformName === "win32" && pathEnv) {
    delete env.PATH;
    delete env.Path;
    env.Path = pathEnv;
  }
  return { env, pathEnv };
}

/**
 * Спавн MCP-сервера. Голое имя (`npx`, `npm`) на Windows — это `.cmd`-шим,
 * который `spawn` не находит (ENOENT) и не запускает без shell (EINVAL):
 * резолв и `shell: true` делает `spawnSpec`.
 */
export function spawnMcpServer(config: MCPServerConfig): ChildProcess {
  const { env, pathEnv } = spawnEnv(
    { ...process.env, ...config.env },
    config.env,
    process.platform,
  );
  const spec = spawnSpec(config.command!, config.args || [], undefined, pathEnv);
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
