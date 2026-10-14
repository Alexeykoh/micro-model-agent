// По-серверная диагностика LSP: классификация ошибок, команда установки,
// гейты и реальная проба — вынесено из `diagnose.ts` (правило ≤300).
import type { LspServerConfig } from "./types";
import { LspClient } from "./client";
import { findProjectRoot } from "./project-root";
import { resolveNpxLaunch } from "./resolve";
import type { ProjectToolchain } from "./toolchain";
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
  /**
   * Команда ручной установки сервера глобально (чтобы не гонять `npx` каждый
   * раз). `undefined` — ставить нечего или сервер уже глобальный.
   */
  installCommand?: string;
}

/**
 * Классифицировать ошибку запуска/инициализации LSP-сервера. Вынесено отдельно,
 * чтобы doctor и failure-путь модуля считали одинаково.
 */
export function classifyLspError(
  message: string,
  opts: { npxFallback?: boolean } = {},
): LspFailureReason {
  if (/MMA_LSP_OFFLINE|auto-install is disabled/i.test(message)) return "offline";
  if (/not found/i.test(message)) return "binary-missing";
  if (/ENOENT|EINVAL|\bspawn\b/i.test(message)) return "spawn-failed";
  if (/timeout/i.test(message)) return opts.npxFallback ? "network" : "timeout";
  return "server-error";
}

/** Нативные установщики LSP-серверов, которым npx не подходит. */
const NATIVE_INSTALL: Record<string, string> = {
  "rust-analyzer": "rustup component add rust-analyzer",
  gopls: 'go install golang.org/x/tools/gopls@latest',
};

/** Имя и версия npx-пакета: `typescript@5` → [`typescript`, `5`]. */
function splitPackage(pkg: string): [name: string, version: string | undefined] {
  const at = pkg.lastIndexOf("@");
  return at > 0 ? [pkg.slice(0, at), pkg.slice(at + 1)] : [pkg, undefined];
}

/**
 * Подставить версию из тулчейна проекта к npx-пакету. Сервер, идущий через npx,
 * не должен тянуть «последнюю» версию, несовместимую с рантаймом проекта:
 * если проект объявляет версию этого пакета — берём её.
 */
function pinPackage(pkg: string, toolchain?: ProjectToolchain): string {
  const [name] = splitPackage(pkg);
  const declared = toolchain?.packages[name];
  if (!declared) return pkg;
  const v = declared.replace(/^[\^~>=<v\s]+/, "").trim();
  return v ? `${name}@${v}` : pkg;
}

/** Команда нативной установки с учётом объявленного тулчейна (rust channel). */
function nativeInstallCommand(
  server: LspServerConfig,
  toolchain?: ProjectToolchain,
): string | null {
  const cmd = NATIVE_INSTALL[server.command] ?? null;
  if (!cmd) return null;
  if (server.command === "rust-analyzer") {
    const channel = toolchain?.runtimes.find((r) => r.name === "rust")?.version;
    return channel ? `${cmd} --toolchain ${channel}` : cmd;
  }
  return cmd;
}

/** Пакеты из npx-args (`--package X`), дедуп с сохранением порядка. */
export function npxPackages(args: string[] | undefined): string[] {
  const list = args ?? [];
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "--package" && list[i + 1]) {
      const pkg = list[i + 1];
      if (!out.includes(pkg)) out.push(pkg);
      i++;
    }
  }
  return out;
}

/**
 * Команда ручной глобальной установки сервера. Заполняется только когда это
 * реально помогает: сервер идёт через `npx` (медленный старт) либо глобального
 * бинарника нет. Уже глобальный и работающий сервер — `null`. Версии пакетов и
 * для нативных серверов берутся из объявленного тулчейна проекта (все языки),
 * чтобы не советовать сборку под чужой рантайм.
 */
export function installCommandFor(
  server: LspServerConfig,
  reason: LspFailureReason,
  useNpxFallback: boolean,
  toolchain?: ProjectToolchain,
): string | null {
  const useful =
    useNpxFallback || reason === "binary-missing" || reason === "offline" || reason === "network";
  if (!useful) return null;
  const pkgs = npxPackages(server.args);
  if (pkgs.length > 0) return `npm i -g ${pkgs.map((p) => pinPackage(p, toolchain)).join(" ")}`;
  return nativeInstallCommand(server, toolchain);
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
