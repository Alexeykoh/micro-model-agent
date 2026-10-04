// Проба LSP-серверов проекта: spawn + initialize + shutdown волнами (для баннера REPL).
import type { LspConfig, LspServerConfig } from "./types";
import { LspClient } from "./client";
import { getServerKeyForFile } from "./config";
import { collectCheckFiles } from "./check-tool";
import { findProjectRoot } from "./project-root";
import { errMsg } from "../../utils";
import {
  LSP_PROBE_TIMEOUT_MS as DEFAULT_PROBE_TIMEOUT_MS,
  LSP_PROBE_DEADLINE_MS as DEFAULT_PROBE_DEADLINE_MS,
} from "../../config/timeouts";

/**
 * Итог пробы одного сервера: какой язык покрывает и реально ли стартанул
 * (spawn + initialize успешны).
 */
export interface LspProbeResult {
  language: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

/** Итоги проб серверов, применимых к проекту. */
export interface LspProbeSummary {
  /** Успешно стартовавшие серверы. */
  ok: LspProbeResult[];
  /** Не стартовавшие серверы. */
  failed: LspProbeResult[];
  /** True, если к файлам проекта ни один LSP-сервер не применим. */
  noneApplicable: boolean;
}

/** Зависимости пробы (таймауты, параллелизм, инжекции для тестов). */
export interface LspProbeDeps {
  client?: LspClient;
  /** Кап таймаута пробы на сервер, мс. */
  timeoutMs?: number;
  /** Общий дедлайн пробы, мс (ограничивает баннер при битых серверах). */
  deadlineMs?: number;
  /**
   * Сколько серверов пробить конкурентно. Последовательно (1) безопаснее на
   * холодном npx-кеше (см. ниже); больше — быстрее баннер REPL на тёплом кеше.
   * У каждого сервера в волне свой LspClient (клиент stateful, конкурентные
   * пробы на общем инстансе попортили бы друг другу состояние запрос/ответ).
   */
  maxParallel?: number;
  /** Инжектируемый сборщик файлов (тесты). */
  collectFiles?: (baseDir: string, config: LspConfig) => Promise<string[]>;
  /** Логгер для отчётов об ошибках. */
  logger?: { debug(msg: string, meta?: Record<string, unknown>): void; info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void; error(msg: string, meta?: Record<string, unknown>): void };
}

const DEFAULT_MAX_PARALLEL = 3;

/**
 * Выяснить, какие LSP-серверы применимы к проекту (тот же ограниченный обход,
 * что в lsp_check), и пробить каждый: spawn + initialize + shutdown.
 * Для баннера REPL — мёртвый сервер виден до первой записи.
 */
export async function probeLspServers(
  config: LspConfig,
  baseDir: string,
  deps: LspProbeDeps = {},
): Promise<LspProbeSummary> {
  if (!config.enabled) return { ok: [], failed: [], noneApplicable: true };

  const timeoutCap = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_PROBE_DEADLINE_MS;
  const maxParallel = deps.maxParallel ?? DEFAULT_MAX_PARALLEL;
  const collect = deps.collectFiles ?? collectCheckFiles;

  const files = await collect(baseDir, config);
  const seen = new Set<string>();
  const servers: Array<{ language: string; config: LspServerConfig }> = [];
  for (const file of files) {
    const language = getServerKeyForFile(file, config);
    if (!language) continue;
    const server = config.servers[language];
    if (!server || seen.has(language)) continue;
    seen.add(language);
    servers.push({ language, config: server });
  }

  if (servers.length === 0) return { ok: [], failed: [], noneApplicable: true };

  // Проба ограниченными волнами. Параллельная проба всего на холодном
  // npx-кеше заставляет серверы драться за общий лок кеша — наблюдалось как
  // `LSP request timeout: initialize` у половины серверов. Чисто
  // последовательная проба убирает драку, но удваивает ожидание баннера REPL
  // (сервер ~2с). Волна `maxParallel` держит баннер быстрым на тёплом кеше и
  // режет конкуренцию на холодном; у каждого сервера в волне свой LspClient
  // (клиент stateful — процесс, id запросов, буфер ответов, — конкурентные
  // пробы на общем инстансе кросс-токали бы). Инжектированный клиент (тесты)
  // переиспользуется на все серверы.
  const ok: LspProbeResult[] = [];
  const failed: LspProbeResult[] = [];
  const deadline = Date.now() + deadlineMs;

  const probeOne = async (language: string, server: LspServerConfig): Promise<void> => {
    const projectRoot = findProjectRoot(baseDir, baseDir, server.workspaceMarkers ?? []);
    const serverTimeout = Math.min(server.timeout ?? timeoutCap, timeoutCap);
    const started = Date.now();
    const probeClient = deps.client ?? new LspClient();
    if (!deps.client) {
      probeClient.setLogger(deps.logger ?? null);
      probeClient.setOffline(config.offline);
    }
    try {
      await probeClient.probe(server, projectRoot, serverTimeout);
      ok.push({ language, ok: true, durationMs: Date.now() - started });
    } catch (e) {
      const errorMsg = errMsg(e);
      deps.logger?.warn(`LSP probe failed for ${language}: ${errorMsg}`, {
        command: server.command,
        timeout: serverTimeout,
        durationMs: Date.now() - started,
      });
      failed.push({
        language,
        ok: false,
        error: errorMsg,
        durationMs: Date.now() - started,
      });
    }
  };

  for (let i = 0; i < servers.length; i += maxParallel) {
    if (Date.now() >= deadline) {
      const remaining = servers.slice(i).map((s) => s.language);
      deps.logger?.warn(`LSP probe deadline reached, skipping: ${remaining.join(", ")}`);
      for (const { language } of servers.slice(i)) {
        failed.push({ language, ok: false, error: "timeout", durationMs: 0 });
      }
      break;
    }
    const wave = servers.slice(i, i + maxParallel);
    await Promise.all(wave.map(({ language, config: server }) => probeOne(language, server)));
  }

  return { ok, failed, noneApplicable: false };
}
