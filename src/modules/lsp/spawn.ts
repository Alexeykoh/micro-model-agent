// Спавн процесса LSP-сервера: резолв команды и фабрика `child_process.spawn`.
//
// Вынесено из `connection.ts`: запуск сервера — самостоятельный шов (у него
// своя политика pid/оболочки), и транспорт не должен расти из-за неё
// (правило 6 AGENTS).
import { resolveSpawnCommand, buildWinCommandLine } from "./command";
import { resolveNpxLaunch, isOfflineLsp } from "./resolve";
import type { LspClientLogger } from "./client-logger";
import type { LspServerConfig } from "./types";
import type { LaunchPlan, ServerProcess, ServerProcessFactory } from "./connection";

/** Windows ли. */
export function platformIsWindows(): boolean {
  return process.platform === "win32";
}

/**
 * Эффективная команда запуска: npx→глобальный бинарник, офлайн-гейт.
 * Windows-обвязка (.cmd через cmd.exe) живёт в фабрике спавна.
 */
export function resolveLaunchPlan(
  config: LspServerConfig,
  offline: boolean | undefined,
  logger?: LspClientLogger | null,
): LaunchPlan {
  const launch = resolveNpxLaunch(config.command, config.args ?? []);
  if (launch.command !== config.command) {
    logger?.debug(`LSP: using globally installed ${launch.binaryName} (skipped npx)`);
  } else if (launch.useNpxFallback && launch.binaryName) {
    logger?.debug(`LSP: ${launch.binaryName} not found globally, falling back to npx`);
  }
  if (launch.useNpxFallback && isOfflineLsp(undefined, offline)) {
    throw new Error(
      `LSP offline mode: ${launch.binaryName ?? "npx"} not found in PATH; ` +
        "npx auto-install is disabled (MMA_LSP_OFFLINE)",
    );
  }
  return { command: launch.command, args: launch.args };
}

/**
 * Дефолтная фабрика: `child_process.spawn`. На Windows `.cmd`/`.bat`-шим
 * не стартует напрямую — команда со аргументами уходит через `shell: true`.
 */
export const defaultSpawn: ServerProcessFactory = async (plan, cwd) => {
  const { spawn } = await import("child_process");
  const isWin = platformIsWindows();
  let command = resolveSpawnCommand(plan.command);
  let args = plan.args;
  const options: Record<string, unknown> = {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    windowsHide: true,
    // POSIX: потомок — лидер группы, чтобы `killTree()` достал всю цепочку
    // (npx → node → tsserver). Windows — taskkill /T.
    detached: !isWin,
  };
  if (isWin) {
    command = buildWinCommandLine(command, args);
    args = [];
    options.shell = true;
  }
  const child = spawn(command, args, options) as unknown as {
    stdin: ServerProcess["stdin"];
    stdout: ServerProcess["stdout"];
    pid?: number;
    kill(signal?: number | string): boolean;
    once(event: "exit", cb: () => void): unknown;
    on(event: "error", cb: (error: Error) => void): unknown;
    on(event: "data", cb: (chunk: Buffer) => void): unknown;
  };
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    // pid сервера: без него teardown убивал только оболочку, а сам сервер
    // оставался жить (аудит §8.1).
    pid: child.pid,
    kill: (signal) => child.kill(signal),
    once: (event, cb) => {
      child.once(event, cb);
    },
    on: (event, cb) => {
      if (event === "error") child.on("error", cb);
    },
  };
};
