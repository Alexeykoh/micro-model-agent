// Фасад LSP-клиента: тот же публичный контракт, что и раньше (`checkFile`,
// `probe`, `workspaceSymbol`, `setLogger`, `setOffline`), но внутри — пул
// тёплых соединений (`pool.ts`), а не spawn+kill на каждую проверку.
//
// Именно здесь исправлен первопричинный дефект: `checkFile` больше не создаёт
// процесс сервера. Он берёт живое соединение из пула, синкает документ
// (`didOpen`/`didChange`) и спрашивает диагностику. Индекс language server'а
// переживает правки — раньше он умирал на каждой.
import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";
import type { LspDiagnostic, LspServerConfig } from "./types";
import { LspConnection, type ServerProcessFactory, type LaunchPlan } from "./connection";
import { LspConnectionPool } from "./pool";
import { languageIdForPath } from "./language";
import { pathToUri } from "./uri";
import { mapWorkspaceSymbols, type LspSymbolLocation } from "./symbols";
import type { LspClientLogger } from "./client-logger";
import { LSP_DEFAULT_TIMEOUT_MS } from "../../config/timeouts";

export { FileOnlyLogger, type LspClientLogger } from "./client-logger";

/**
 * Итог проверки файла. `inconclusive` отличает «сервер промолчал» от «сервер
 * сказал, что чисто»: раньше таймаут возвращал пустой список, и модель делала
 * вывод, что ошибок нет.
 */
export interface CheckResult {
  diagnostics: LspDiagnostic[];
  inconclusive: boolean;
}

/** Зависимости клиента. Единственный способ инъекции (пул, спавн, логгер). */
export interface LspClientDeps {
  logger?: LspClientLogger | null;
  offline?: boolean;
  /** Готовый пул (тесты); иначе строится из spawn/resolveLaunch. */
  pool?: LspConnectionPool;
  /** Фабрика процесса сервера (тесты). */
  spawn?: ServerProcessFactory;
  /** Резолв команды запуска (тесты). */
  resolveLaunch?: (config: LspServerConfig) => LaunchPlan;
}

/** Логгер-совместимый клиент с пулом соединений. */
export class LspClient {
  private deps: LspClientDeps;
  private poolInstance: LspConnectionPool | null = null;

  constructor(deps: LspClientDeps = {}) {
    this.deps = deps;
  }

  /**
   * Пул создаётся лениво: `setLogger`/`setOffline` вызываются после
   * конструктора (LspModule делает это сразу), и соединения должны видеть
   * актуальные зависимости.
   */
  private get pool(): LspConnectionPool {
    if (!this.poolInstance) {
      this.poolInstance = this.deps.pool ?? new LspConnectionPool(this.deps);
    }
    return this.poolInstance;
  }

  /** Назначить логгер (null — молчать). */
  setLogger(logger: LspClientLogger | null): void {
    this.deps = { ...this.deps, logger };
  }

  /**
   * Офлайн-флаг из конфига (`config.lsp.offline`). Env `MMA_LSP_OFFLINE`
   * по-прежнему сильнее (см. `isOfflineLsp`). `undefined` — только env.
   */
  setOffline(offline: boolean | undefined): void {
    this.deps = { ...this.deps, offline };
  }

  /** Текущий офлайн-флаг (env поверх него решает `isOfflineLsp`). */
  getOffline(): boolean | undefined {
    return this.deps.offline;
  }

  /** Статистика пула для `/lsp status`: живые соединения, перезапуски, reap. */
  stats(): { live: number; restarts: number; reaped: number } {
    return this.pool.stats();
  }

  /** Сколько соединений живо прямо сейчас (быстрый запрос для UI). */
  liveConnections(): number {
    return this.pool.stats().live;
  }

  /** Закрыть все соединения (конец сессии, `/lsp restart`). */
  async close(): Promise<void> {
    await this.pool.dispose();
  }

  /**
   * Тёплое соединение уже есть (без спавна сервера). Пост-проверка записи
   * смотрит сюда: холодный старт (npx-докачка language server) не должен
   * блокировать запись на десятки секунд (аудит §8.2).
   */
  isWarm(config: LspServerConfig, projectRoot: string): boolean {
    return this.pool.peek(serverKeyFor(config), projectRoot) !== null;
  }

  /** Поднять соединение в фоне (прогрев); ошибки обрабатывает вызывающий. */
  async warmup(config: LspServerConfig, projectRoot: string): Promise<void> {
    await this.pool.acquire(serverKeyFor(config), config, projectRoot);
  }

  /**
   * Проверить файл. Берёт тёплое соединение из пула, синкает содержимое и
   * возвращает диагностики. Соединение остаётся живым (и документ открытым) —
   * следующая проверка того же файла не спавнит сервер заново.
   */
  async checkFile(
    filePath: string,
    _baseDir: string,
    config: LspServerConfig,
    projectRoot: string,
    timeoutMs?: number,
  ): Promise<CheckResult> {
    const timeout = timeoutMs ?? config.timeout ?? LSP_DEFAULT_TIMEOUT_MS;
    const absolute = resolvePath(filePath);
    const uri = pathToUri(absolute);
    const connection = await this.pool.acquire(serverKeyFor(config), config, projectRoot);
    connection.syncUri(uri, languageIdForPath(absolute), readFileOrEmpty(absolute));
    const diagnostics = await connection.diagnosticsFor(uri, timeout);
    return { diagnostics: diagnostics ?? [], inconclusive: diagnostics === null };
  }

  /**
   * Лёгкая проба «сервер реально стартует»: spawn + initialize + shutdown.
   * Для баннера REPL и `/lsp doctor` — мёртвый сервер виден заранее, а не
   * таймаутом первой записи. В пулён не попадает намеренно.
   */
  async probe(config: LspServerConfig, projectRoot: string, timeout: number): Promise<void> {
    const connection = new LspConnection(serverKeyFor(config), projectRoot, config, {
      logger: this.deps.logger ?? null,
      offline: this.deps.offline,
      spawn: this.deps.spawn,
      resolveLaunch: this.deps.resolveLaunch,
      // Проба уважает свой таймаут: иначе «мёртвый» сервер висит дольше
      // отведённого (аудит §8.5).
      timeout,
    });
    try {
      await connection.open();
    } finally {
      await connection.shutdown();
    }
  }

  /**
   * Поиск символа по имени через `workspace/symbol` (обогащение карты
   * проекта). Идёт через пул, чтобы TS-сервер оставался тёплым для последующих
   * проверок. Пустой/битый ответ — пустой список.
   */
  async workspaceSymbol(
    query: string,
    config: LspServerConfig,
    projectRoot: string,
    timeout: number = config.timeout ?? LSP_DEFAULT_TIMEOUT_MS,
  ): Promise<LspSymbolLocation[]> {
    const connection = await this.pool.acquire(serverKeyFor(config), config, projectRoot);
    const result = await connection.request("workspace/symbol", { query }, timeout);
    return mapWorkspaceSymbols(result, projectRoot);
  }
}

function readFileOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/** Стабильная идентичность сервера: команда + аргументы. */
export function serverKeyFor(server: LspServerConfig): string {
  return `${server.command}:${(server.args ?? []).join(" ")}`;
}
