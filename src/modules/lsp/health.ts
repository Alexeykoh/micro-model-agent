// Здоровье LSP-серверов на сессию: счётчик подряд идущих падений, отключение
// после порога, прогрев соединения в фоне (без блокировки записи файла).
//
// Вынесено из `module.ts`: это самостоятельное состояние, а не логика тулов
// (правило 6 AGENTS).
import type { LspClientLogger } from "./client-logger";
import type { LspServerConfig } from "./types";
import { classifyLspError, type LspFailureReason } from "./diagnose";
import { t } from "../../i18n/index";
import { errMsg } from "../../utils";

/**
 * Подряд идущих падений LSP до отключения сервера на сессию. Мёртвый сервер
 * (не стоит, упала npx-автоустановка, нет пути) иначе спамит `[LSP check failed]`
 * на КАЖДУЮ запись, приучая модель игнорировать сигнал целиком.
 */
export const MAX_CONSECUTIVE_LSP_FAILURES = 3;

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
  /** Сервер отключён на сессию (порог падений достигнут). */
  disabled: boolean;
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
 * Здоровье серверов: падения по ключу, отключённые ключи, прогревы в полёте.
 * «Подряд идущие» — успешная проверка/прогрев сбрасывает счётчик.
 */
export class LspHealth {
  private failures = new Map<string, number>();
  private disabled = new Set<string>();
  private warming = new Set<string>();

  /** Отключён ли сервер на эту сессию. */
  isDisabled(key: string): boolean {
    return this.disabled.has(key);
  }

  /** Сбросить счётчик падений (успешная проверка/прогрев). */
  reset(key: string): void {
    this.failures.set(key, 0);
  }

  /** Сбросить всё (например, после `/lsp restart`). */
  resetAll(): void {
    this.failures.clear();
    this.disabled.clear();
  }

  /** Отключённые ключи серверов. */
  disabledKeys(): string[] {
    return Array.from(this.disabled);
  }

  /** Счётчики падений по серверам. */
  counts(): Map<string, number> {
    return new Map(this.failures);
  }

  /** Учесть падение сервера. После порога сервер отключается на сессию. */
  recordFailure(key: string, serverConfig: LspServerConfig, message: string): FailureOutcome {
    const failures = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, failures);
    if (failures >= MAX_CONSECUTIVE_LSP_FAILURES) {
      // Одно громкое actionable-сообщение, дальше — без шума на каждую запись
      // до конца сессии. Модель не должна учиться игнорить LSP.
      this.disabled.add(key);
      return { disabled: true, text: t("lsp.unavailable") };
    }
    return {
      disabled: false,
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
}
