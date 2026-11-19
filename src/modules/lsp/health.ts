// Здоровье LSP-серверов на сессию: счётчик подряд идущих падений, пауза
// восстановления (backoff), прогрев соединения в фоне (без блокировки записи).
//
// Вынесено из `module.ts`: это самостоятельное состояние, а не логика тулов
// (правило 6 AGENTS).
import type { LspClientLogger } from "./client-logger";
import type { LspServerConfig } from "./types";
import { classifyLspError, type LspFailureReason } from "./diagnose";
import { LSP_CRASH_GIVEUP_MS, LSP_CRASH_LIMIT, LSP_CRASH_WINDOW_MS, LSP_RETRY_BASE_MS, LSP_RETRY_MAX_MS } from "../../config/timeouts";import { t } from "../../i18n/index";
import { errMsg } from "../../utils";

/**
 * Подряд идущих падений LSP до паузы восстановления. Сервер НЕ отключается
 * навсегда: после паузы (2 с → 4 с → … → 60 с) он пробуется снова. Мёртвый
 * сервер иначе либо спамил `[LSP check failed]` на каждую запись, либо (как
 * было) выключался до конца сессии из-за одного плохого старта.
 */
export const MAX_CONSECUTIVE_LSP_FAILURES = 3;

/**
 * Пауза перед попыткой N (экспонента с потолком).
 */
export function retryDelayMs(failures: number): number {
  const step = Math.max(0, failures - MAX_CONSECUTIVE_LSP_FAILURES);
  return Math.min(LSP_RETRY_BASE_MS * 2 ** step, LSP_RETRY_MAX_MS);
}

/** Ключи actionable-подсказок по классу причины сбоя LSP (одна строка модели). */
const LSP_HINT_KEYS: Partial<Record<LspFailureReason, string>> = {
  "binary-missing": "lsp.hint_binary_missing",
  offline: "lsp.hint_offline",
  network: "lsp.hint_network",
  timeout: "lsp.hint_timeout",
  "spawn-failed": "lsp.hint_spawn",
  "node-too-old": "lsp.hint_node_too_old",
};

/** Подсказка под `[LSP check failed]` (пусто, если класса с действием нет). */
export function failureHint(message: string, npxFallback: boolean): string {
  const key = LSP_HINT_KEYS[classifyLspError(message, { npxFallback })];
  return key ? `\n${t(key)}` : "";
}

/** Итог учёта падения. */
export interface FailureOutcome {
  /** Сервер на паузе восстановления (пробовать сейчас бессмысленно). */
  blocked: boolean;
  /** Сколько ещё ждать до следующей попытки, мс (0 — можно сразу). */
  retryInMs: number;
  /** Текст для модели. */
  text: string;
}

/** Цель прогрева: сервер, его ключ и корень проекта. */
export interface WarmTarget {
  serverConfig: LspServerConfig;
  key: string;
  projectRoot: string;
}

/**
 * Здоровье серверов: падения по ключу, пауза восстановления, прогревы в полёте.
 * «Подряд идущие» — успешная проверка/прогрев сбрасывает счётчик.
 */
export class LspHealth {
  private failures = new Map<string, number>();
  /** До какого времени сервер не пробуем (мс, часы инжектируются для тестов). */
  private blockedUntil = new Map<string, number>();
  /** Времена падений по ключу: окно «N крахов за 3 минуты» (как в VS Code). */
  private crashes = new Map<string, number[]>();
  private warming = new Set<string>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Сервер на паузе восстановления (или отключён до её конца). */
  isDisabled(key: string): boolean {
    return (this.blockedUntil.get(key) ?? 0) > this.now();
  }

  /** Сколько ещё ждать до следующей попытки (0 — можно сейчас). */
  retryInMs(key: string): number {
    return Math.max(0, (this.blockedUntil.get(key) ?? 0) - this.now());
  }

  /** Серверы на паузе: ключ → оставшееся ожидание. Для `/lsp status`. */
  blocked(): Array<{ key: string; retryInMs: number }> {
    const now = this.now();
    return [...this.blockedUntil.entries()]
      .filter(([, until]) => until > now)
      .map(([key, until]) => ({ key, retryInMs: until - now }));
  }

  /** Сбросить счётчик падений и паузу (успешная проверка/прогрев). */
  reset(key: string): void {
    this.failures.set(key, 0);
    this.blockedUntil.delete(key);
    this.crashes.delete(key);
  }

  /** Сбросить всё (например, после `/lsp restart`). */
  resetAll(): void {
    this.failures.clear();
    this.blockedUntil.clear();
  }

  /** Отключённые/стоящие на паузе ключи серверов. */
  disabledKeys(): string[] {
    return this.blocked().map((b) => b.key);
  }

  /** Счётчики падений по серверам. */
  counts(): Map<string, number> {
    return new Map(this.failures);
  }

  /** Учесть падение сервера. После порога — пауза восстановления. */
  recordFailure(key: string, serverConfig: LspServerConfig, message: string): FailureOutcome {
    const failures = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, failures);
    if (failures >= MAX_CONSECUTIVE_LSP_FAILURES) {
      // Окно крахов (как DefaultErrorHandler в vscode-languageclient): серия
      // падений за короткое время — не бесконечный retry, а стоп с причиной.
      const now = this.now();
      const times = [...(this.crashes.get(key) ?? []), now].filter(
        (t) => now - t <= LSP_CRASH_WINDOW_MS,
      );
      this.crashes.set(key, times);
      if (times.length > LSP_CRASH_LIMIT) {
        this.blockedUntil.set(key, now + LSP_CRASH_GIVEUP_MS);
        return {
          blocked: true,
          retryInMs: LSP_CRASH_GIVEUP_MS,
          text: `${t("lsp.unavailable")} ${t("lsp.crashed_too_often", {
            count: String(times.length),
            min: String(Math.round(LSP_CRASH_WINDOW_MS / 60000)),
          })} ${message}`,
        };
      }
      // Одно громкое actionable-сообщение, дальше — пауза вместо спама на
      // каждую запись. По истечении паузы сервер пробуется снова.
      const delay = retryDelayMs(failures);
      this.blockedUntil.set(key, now + delay);
      // Причина сохраняется: «пауза» без причины не отличает несовместимый
      // Node от сетевого таймаута.
      return { blocked: true, retryInMs: delay, text: `${t("lsp.unavailable")} ${message}` };
    }
    return {
      blocked: false,
      retryInMs: 0,
      text: `${message}${failureHint(message, serverConfig.command === "npx")}`,
    };
  }

  /** Лог падения (падающий логгер не должен ломать путь проверки). */
  warn(logger: LspClientLogger | null, filePath: string, message: string): void {
    try {
      logger?.warn(`LSP check failed for ${filePath}: ${message}`);
    } catch {
      /* логгер — не часть контракта проверки */
    }
  }

  /**
   * Прогрев соединения в фоне (один на ключ). Холодный старт (npx-докачка
   * language server) не должен блокировать запись на десятки секунд.
   */
  warmInBackground(opts: {
    key: string;
    warm: () => Promise<void>;
    onSuccess?: () => void;
    onError: (message: string) => void;
  }): void {
    if (this.warming.has(opts.key)) return;
    this.warming.add(opts.key);
    void opts
      .warm()
      .then(() => {
        this.reset(opts.key);
        opts.onSuccess?.();
      })
      .catch((e: unknown) => {
        opts.onError(errMsg(e));
      })
      .finally(() => {
        this.warming.delete(opts.key);
      });
  }

  /** Идёт ли прогрев этого ключа (для дедупа внешних вызовов). */
  isWarming(key: string): boolean {
    return this.warming.has(key);
  }
}
