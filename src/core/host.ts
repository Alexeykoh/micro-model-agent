/** Хост-контракт: мост для плагинов + снапшот состояния для UI. */
import type { OutputEvent } from "../output/types";
import { defaultOutputBus } from "../output/bus";
import type { HostBridge, HostBridgeSubmitOptions } from "../modules/types";
import type { ContextBreakdown, ContextQualityBreakdown, LlmSpeedSnapshot } from "./types";
// Только тип (не исполнение): снимок собирает web-обвязка из `tools/git-core`
// (спека git-workflow §2: ядро git не дёргает; тут контракт поля).
import type { GitSnapshot } from "../tools/git-core";

/**
 * Статус шага плана для хоста. `skipped` не входит в контракт —
 * планы исполнения маппят его на settled-состояние.
 */
export type PlanStepStatus = "pending" | "in_progress" | "done" | "failed";

/** Разбивка карты проекта по языку (для вкладки Map). */
export interface ProjectMapLanguage {
  language: string;
  files: number;
  symbols: number;
}

/** Статистика карты проекта, отдаваемая веб-сайдбару. */
export interface ProjectMapInfo {
  indexed: boolean;
  /** Обход идёт прямо сейчас. */
  indexing?: boolean;
  files: number;
  symbols: number;
  tokens: number;
  /** Время сборки индекса (epoch ms) или null. */
  updatedAt?: number | null;
  languages?: ProjectMapLanguage[];
  /** Вотчер индексатора активен. */
  watcher?: boolean;
}

/**
 * Снапшот состояния для сайдбара/топбара. Поля best-effort:
 * отсутствуют, если модуль недоступен (например, сессии ещё нет).
 */
export interface HostStateSnapshot {
  busy: boolean;
  sessionId?: string;
  sessionName?: string;
  model?: string;
  provider?: string;
  /** `false` — активный эндпоинт не отвечает; `undefined` — ещё не проверяли. */
  providerReachable?: boolean;
  contextUsed?: number;
  contextLimit?: number;
  costUsd?: number;
  compactionCount?: number;
  /** Хитрейт промпт-кэша за последний ход (0..1); нет, если неизвестен. */
  cacheHitRate?: number;
  /** Накопленные входящие токены сессии (prompt). */
  promptTokensTotal?: number;
  /** Накопленные исходящие токены сессии (completion). */
  completionTokensTotal?: number;
  /** Накопленные кэшированные токены сессии. */
  cachedTokensTotal?: number;
  /** Оценка качества контекста за последний ход (0..100); нет, если неизвестна. */
  contextQuality?: number;
  /** Разбор оценки качества: составляющие и веса (для поп-апа в UI). */
  contextQualityBreakdown?: ContextQualityBreakdown;
  /** Сегментная разбивка контекста (system/tools/history/reserve/free). */
  contextBreakdown?: ContextBreakdown;
  /** Скорость генерации последнего хода (decode без префилла). */
  llmSpeed?: LlmSpeedSnapshot;
  /**
   * Проба контекста LM Studio (фактический vs настроенный). Нет, пока проба
   * в пути или провайдер не опрашивается; `null` — проба пустая.
   */
  contextProbe?: { model: string; actual: number } | null;
  /**
   * Эффективное окно контекста (токены) для бюджетирования. В снапшоте,
   * чтобы веб-клиент узнал о позднем автодетекте без перечитывания `/api/config`.
   */
  contextWindow?: number;
  /** Workspace агента (каталог `-d`), абсолютный; нет, если неизвестен. */
  workspace?: string;
  /**
   * Версия установленного пакета (`package.json`), а не `config.version` —
   * та хранит версию схемы конфига. Показывается в футере под композером.
   */
  version?: string;
  /** Локальная dev-сборка (запуск из src/, не из dist/). */
  dev?: boolean;
  /**
   * Доступная новая версия (`current` → `latest`). Заполняется апдейтером:
   * в вебе единственный способ узнать об апдейте (в stdout никто не смотрит),
   * поэтому рисуется чипом в футере под композером.
   */
  updateAvailable?: { current: string; latest: string };
  /** Источники инструкций AGENTS.md (`disabled` — флаг --no-agents-md). */
  instructions?: { files: string[]; disabled: boolean };
  /** Статистика карты проекта; `indexed:false`, пока обход не завершён. */
  projectMap?: ProjectMapInfo;
  /**
   * Снимок git workspace (ветка/dirty/worktree/теги) для чипов и вкладки
   * Changes. Заполняет web-обвязка из кеша (`buildHostState` синхронный —
   * здесь всегда последний снимок, не живой вызов). `null` — не репозиторий.
   */
  git?: GitSnapshot | null;
  /**
   * Монотонный счётчик изменений файлов workspace (вотчер индексатора).
   * Клиент вкладки Files перечитывает раскрытые папки при его росте — это
   * фолбэк на случай пропущенного SSE `files`.
   */
  filesRevision?: number;
  /** Словари i18n на диске новее старта сервера — клиенту показан бейдж
   *  «перезапустите сервер» (иначе сырые ключи вместо подписей). */
  i18nStale?: boolean;
  plan?: {
    steps: { text: string; status: PlanStepStatus }[];
    currentIndex: number;
  } | null;
}

/**
 * Ненулевой снапшот плана в выделенном событии `plan` (web SSE и service).
 * Переиспользует host-контракт, чтобы все клиенты рендерили одну форму.
 */
export type PlanSnapshot = NonNullable<HostStateSnapshot["plan"]>;

/**
 * Полная поверхность хоста. `HostBridge` (узкий, для плагинов) — контракт
 * плагинов; `Host` добавляет нужное веб-режиму. Реализации: `Repl`, `WebHost`.
 */
export interface Host extends HostBridge {
  /** Выполняет slash-команду (напр. "/status") через общую карту хендлеров. */
  executeCommand(line: string): Promise<void>;
  /**
   * Текущее состояние для сайдбара/топбара.
   * @param sessionId конкретная сессия (веб-вкладка); без него — активная.
   */
  getState(sessionId?: string): HostStateSnapshot;
}

/** Опции фабрики хост-моста: занятость, картинки, запуск и прерывание. */
export interface CreateHostBridgeOptions {
  isBusy: () => boolean;
  addPendingImage: (dataUrl: string) => void;
  runAgent: (text: string) => Promise<unknown>;
  interruptRun: () => void;
}

/**
 * Строит HostBridge для плагинов (`ctx.hostBridge`). Веб-клиенты (и любой
 * плагин) шлют сообщения через ТОТ ЖЕ runAgent-путь, что и терминальный ввод:
 * рендеринг, лог сессии и single-flight guard общие, без дублирования.
 */
export function createHostBridge(opts: CreateHostBridgeOptions): HostBridge {
  return {
    isBusy: opts.isBusy,
    async submit(text: string, o?: HostBridgeSubmitOptions) {
      if (opts.isBusy()) throw new Error("agent is busy");
      for (const url of o?.images ?? []) opts.addPendingImage(url);
      return opts.runAgent(text);
    },
    interrupt() {
      if (opts.isBusy()) opts.interruptRun();
    },
    subscribeOutput: (fn: (ev: OutputEvent) => void) => defaultOutputBus.subscribe(fn),
  };
}
