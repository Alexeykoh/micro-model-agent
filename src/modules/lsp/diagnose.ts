// Диагностика LSP-серверов проекта: причина неисправности + класс + проба.
import type { LspConfig, LspServerConfig } from "./types";
import { LspClient, type LspClientLogger } from "./client";
import { getServerKeyForFile } from "./config";
import { collectCheckFiles } from "./check-tool";
import { findProjectRoot } from "./project-root";
import { findOnPath, resolveNpxLaunch, isOfflineLsp } from "./resolve";
import {
  LSP_DOCTOR_TIMEOUT_MS as DEFAULT_TIMEOUT_MS,
  LSP_DOCTOR_DEADLINE_MS as DEFAULT_DEADLINE_MS,
} from "../../config/timeouts";
import { errMsg } from "../../utils";

/**
 * Класс причины неисправности LSP-сервера. Единственный источник правды для
 * `/lsp doctor` и actionable-подсказок в `[LSP check failed]`.
 */
export type LspFailureReason =
  | "ok"
  | "disabled"
  | "not-applicable"
  | "binary-missing"
  | "offline"
  | "network"
  | "timeout"
  | "spawn-failed"
  | "server-error"
  | "deadline";

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
}

/** Полная диагностика LSP проекта (для `/lsp doctor`). */
export interface LspDiagnosis {
  enabled: boolean;
  offline: boolean;
  projectRoot: string;
  servers: LspServerDiagnosis[];
}

/** Зависимости диагностики (инжекции для тестов). */
export interface LspDiagnoseDeps {
  client?: LspClient;
  /** Кап таймаута одного сервера, мс. */
  timeoutMs?: number;
  /** Общий дедлайн, мс. */
  deadlineMs?: number;
  /** Инжектируемый сборщик файлов (тесты). */
  collectFiles?: (baseDir: string, config: LspConfig) => Promise<string[]>;
  /** Инжектируемый поиск бинарника в PATH (тесты). */
  findOnPath?: (name: string) => string | null;
  /** Override офлайн-режима (по умолчанию `MMA_LSP_OFFLINE`). */
  offline?: boolean;
  logger?: LspClientLogger;
}

/**
 * Классифицировать ошибку запуска/инициализации LSP-сервера. Вынесено отдельно,
 * чтобы doctor и failure-путь модуля считали одинаково.
 */
export function classifyLspError(
  message: string,
  opts: { npxFallback?: boolean } = {},
): LspFailureReason {
  if (/not found in PATH/i.test(message)) return "binary-missing";
  if (/MMA_LSP_OFFLINE|auto-install is disabled/i.test(message)) return "offline";
  if (/ENOENT|EINVAL|\bspawn\b/i.test(message)) return "spawn-failed";
  if (/timeout/i.test(message)) return opts.npxFallback ? "network" : "timeout";
  return "server-error";
}

/**
 * Продиагностировать LSP-серверы, применимые к проекту: применимость,
 * включённость, резолв запуска, реальная проба (`spawn+initialize`) и класс
 * причины. Сервера, которым не нужна сеть и которые заведомо не стартуют
 * (disabled / нет файлов / нет бинарника / офлайн), не пробуются.
 */
export async function diagnoseLspServers(
  config: LspConfig,
  baseDir: string,
  deps: LspDiagnoseDeps = {},
): Promise<LspDiagnosis> {
  const offline = deps.offline ?? isOfflineLsp();
  const timeoutCap = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const collect = deps.collectFiles ?? collectCheckFiles;
  const probePath = deps.findOnPath ?? findOnPath;
  const entries = Object.entries(config.servers);

  if (!config.enabled) {
    return {
      enabled: false,
      offline,
      projectRoot: baseDir,
      servers: entries.map(([language, server]) =>
        baseDiagnosis(language, server, { enabled: false, applicable: false, reason: "disabled" }),
      ),
    };
  }

  const files = await collect(baseDir, config);
  const applicable = new Set<string>();
  for (const file of files) {
    const key = getServerKeyForFile(file, config);
    if (key) applicable.add(key);
  }

  const client = deps.client ?? new LspClient();
  if (!deps.client) client.setLogger(deps.logger ?? null);

  const ctx: ServerContext = {
    offline,
    deadline: Date.now() + deadlineMs,
    client,
    baseDir,
    defaultTimeout: config.timeout,
    timeoutCap,
    probePath,
  };
  const servers: LspServerDiagnosis[] = [];
  for (const [language, server] of entries) {
    servers.push(await diagnoseServer(language, server, applicable.has(language), ctx));
  }

  return { enabled: true, offline, projectRoot: baseDir, servers };
}

/** Общий контекст диагностики (неизменяемый на прогон). */
interface ServerContext {
  offline: boolean;
  deadline: number;
  client: LspClient;
  baseDir: string;
  defaultTimeout: number;
  timeoutCap: number;
  probePath: (name: string) => string | null;
}

/** Диагностировать один сервер: гейты (disabled/неприменим/офлайн/дедлайн) + проба. */
async function diagnoseServer(
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
  if (skip) return { ...withLaunch, reason: skip };
  if (Date.now() >= ctx.deadline) return { ...withLaunch, reason: "deadline" };

  const probe = await probeServer(
    ctx.client,
    server,
    ctx.baseDir,
    ctx.defaultTimeout,
    ctx.timeoutCap,
    launch.useNpxFallback,
  );
  return { ...withLaunch, ...probe };
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
): Promise<Pick<LspServerDiagnosis, "probed" | "ok" | "reason" | "error" | "durationMs">> {
  const projectRoot = findProjectRoot(baseDir, baseDir, server.workspaceMarkers ?? []);
  const serverTimeout = Math.min(server.timeout ?? defaultTimeout, timeoutCap);
  const started = Date.now();
  try {
    await client.probe(server, projectRoot, serverTimeout);
    return { probed: true, ok: true, reason: "ok", durationMs: Date.now() - started };
  } catch (e) {
    const msg = errMsg(e);
    return {
      probed: true,
      ok: false,
      reason: classifyLspError(msg, { npxFallback }),
      error: msg,
      durationMs: Date.now() - started,
    };
  }
}

/** Собрать базовую запись диагностики сервера с дефолтной причиной. */
function baseDiagnosis(
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
