// Диагностика LSP-серверов проекта: причина неисправности + класс + проба.
import type { LspConfig } from "./types";
import { LspClient, type LspClientLogger } from "./client";
import { getServerKeyForFile } from "./config";
import { collectCheckFiles, LSP_DIAGNOSE_SCAN_LIMIT } from "./check-tool";
import { findOnPath, isOfflineLsp } from "./resolve";
import {
  LSP_DOCTOR_TIMEOUT_MS as DEFAULT_TIMEOUT_MS,
  LSP_DOCTOR_DEADLINE_MS as DEFAULT_DEADLINE_MS,
} from "../../config/timeouts";
import {
  diagnoseServer,
  baseDiagnosis,
  type LspServerDiagnosis,
  type ServerContext,
} from "./diagnose-server";

// Классификация/установка/типы сервера живут в `./diagnose-server`; реэкспорт
// для существующих импортёров (`./module`, `./index`, тесты).
export { classifyLspError, npxPackages, installCommandFor } from "./diagnose-server";
export type { LspFailureReason, LspServerDiagnosis } from "./diagnose-server";

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
  const offline = deps.offline ?? isOfflineLsp(undefined, config.offline);
  const timeoutCap = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const collect =
    deps.collectFiles ??
    ((dir: string, cfg: LspConfig) => collectCheckFiles(dir, cfg, LSP_DIAGNOSE_SCAN_LIMIT));
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
  if (!deps.client) {
    client.setLogger(deps.logger ?? null);
    client.setOffline(config.offline);
  }

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
