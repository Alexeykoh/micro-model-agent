// По-серверная диагностика LSP: гейты и реальная проба.
//
// Причина/классификация — `./failure-reason`, подсказки установки — `./install-hint`
// (оба вынесены, чтобы файл остался под потолком ≤300 строк).
import type { LspServerConfig } from "./types";
import type { LspClient, LspProbeError } from "./client";
import { findProjectRoot } from "./project-root";
import { resolveNpxLaunch } from "./resolve";
import type { ProjectToolchain } from "./toolchain";
import type { LspFailureReason } from "./failure-reason";
import { classifyLspError } from "./failure-reason";
import { installCommandFor } from "./install-hint";
import { errMsg } from "../../utils";

export { classifyLspError, type LspFailureReason } from "./failure-reason";
export { installCommandFor, npxPackages } from "./install-hint";

/** Диагностика одного сервера: применимость, резолв запуска, проба, причина. */
export interface LspServerDiagnosis {
  language: string;
  command: string;
  args: string[];
  enabled: boolean;
  applicable: boolean;
  autoInstall: boolean;
  effectiveCommand?: string;
  binaryName?: string | null;
  binaryOnPath?: boolean;
  useNpxFallback?: boolean;
  probed: boolean;
  ok: boolean;
  reason: LspFailureReason;
  error?: string;
  durationMs?: number;
  /** Хвост stderr упавшего сервера (единственный след краха до `initialize`). */
  stderrTail?: string;
  /**
   * Команда ручной установки сервера глобально (чтобы не гонять `npx` каждый
   * раз). `undefined` — ставить нечего или сервер уже глобальный.
   */
  installCommand?: string;
}

/** Общий контекст диагностики (неизменяемый на прогон). */
export interface ServerContext {
  offline: boolean;
  deadline: number;
  client: LspClient;
  baseDir: string;
  defaultTimeout: number;
  timeoutCap: number;
  probePath: (name: string) => string | null;
  /** Объявленные версии тулчейна проекта (для версионных подсказок установки). */
  toolchain?: ProjectToolchain;
}

/** Диагностировать один сервер: гейты (disabled/неприменим/офлайн/дедлайн) + проба. */
export async function diagnoseServer(
  language: string,
  server: LspServerConfig,
  applicable: boolean,
  ctx: ServerContext,
): Promise<LspServerDiagnosis> {
  const enabled = server.enabled !== false;
  const base = baseDiagnosis(language, server, { enabled, applicable });
  if (!enabled) return { ...base, reason: "disabled" };
  if (!applicable) return { ...base, reason: "not-applicable" };

  const launch = resolveServerLaunch(server, ctx.probePath);
  const withLaunch: LspServerDiagnosis = {
    ...base,
    effectiveCommand: launch.command,
    binaryName: launch.binaryName,
    binaryOnPath: launch.binaryOnPath,
    useNpxFallback: launch.useNpxFallback,
  };
  const skip = skipReason(server, launch, ctx.offline);
  if (skip) {
    return withCommand({ ...withLaunch, reason: skip }, server, skip, launch.useNpxFallback, ctx.toolchain);
  }
  if (Date.now() >= ctx.deadline) {
    return withCommand({ ...withLaunch, reason: "deadline" }, server, "deadline", launch.useNpxFallback, ctx.toolchain);
  }

  const probe = await probeServer(
    ctx.client,
    server,
    ctx.baseDir,
    ctx.defaultTimeout,
    ctx.timeoutCap,
    launch.useNpxFallback,
  );
  return withCommand({ ...withLaunch, ...probe }, server, probe.reason, launch.useNpxFallback, ctx.toolchain);
}

/** Дополнить диагноз командой установки, если она применима. */
function withCommand(
  diag: LspServerDiagnosis,
  server: LspServerConfig,
  reason: LspFailureReason,
  useNpxFallback: boolean,
  toolchain?: ProjectToolchain,
): LspServerDiagnosis {
  const installCommand = installCommandFor(server, reason, useNpxFallback, toolchain);
  return installCommand ? { ...diag, installCommand } : diag;
}

/** Резолв запуска сервера: npx→глобальный бинарник или собственный бинарник. */
function resolveServerLaunch(
  server: LspServerConfig,
  probePath: (name: string) => string | null,
): ReturnType<typeof resolveNpxLaunch> {
  if (server.command === "npx") {
    return resolveNpxLaunch(server.command, server.args ?? [], probePath);
  }
  return {
    command: server.command,
    args: server.args ?? [],
    binaryName: server.command,
    binaryOnPath: probePath(server.command) != null,
    useNpxFallback: false,
  };
}

/** Заведомо непроходимые серверы: нет бинарника (native) или офлайн + npx. */
function skipReason(
  server: LspServerConfig,
  launch: ReturnType<typeof resolveNpxLaunch>,
  offline: boolean,
): LspFailureReason | null {
  if (server.autoInstall === false && !launch.useNpxFallback && !launch.binaryOnPath) {
    return "binary-missing";
  }
  if (offline && launch.useNpxFallback) return "offline";
  return null;
}

/** Реально пробует сервер (`spawn+initialize`) и классифицирует исход. */
async function probeServer(
  client: LspClient,
  server: LspServerConfig,
  baseDir: string,
  defaultTimeout: number,
  timeoutCap: number,
  npxFallback: boolean,
): Promise<Pick<LspServerDiagnosis, "probed" | "ok" | "reason" | "error" | "durationMs" | "stderrTail">> {
  const projectRoot = findProjectRoot(baseDir, baseDir, server.workspaceMarkers ?? []);
  const serverTimeout = Math.min(server.timeout ?? defaultTimeout, timeoutCap);
  const started = Date.now();
  try {
    await client.probe(server, projectRoot, serverTimeout);
    return { probed: true, ok: true, reason: "ok", durationMs: Date.now() - started };
  } catch (e) {
    const msg = errMsg(e);
    const stderrTail = (e as LspProbeError).stderrTail;
    // Причина краха часто есть только в stderr: упавший сервер отвечает
    // «connection closed», а не ошибкой рантайма.
    const evidence = stderrTail ? `${msg}\n${stderrTail}` : msg;
    return {
      probed: true,
      ok: false,
      reason: classifyLspError(evidence, { npxFallback }),
      error: msg,
      durationMs: Date.now() - started,
      stderrTail,
    };
  }
}

/** Собрать базовую запись диагностики сервера с дефолтной причиной. */
export function baseDiagnosis(
  language: string,
  server: LspServerConfig,
  overrides: Partial<LspServerDiagnosis>,
): LspServerDiagnosis {
  return {
    language,
    command: server.command,
    args: server.args ?? [],
    enabled: true,
    applicable: false,
    autoInstall: server.autoInstall !== false,
    probed: false,
    ok: false,
    reason: "server-error",
    ...overrides,
  };
}
