/**
 * История ввода REPL: загрузка/сохранение файла и кап строк.
 *
 * Вынесено из `repl.ts` (правило 6). Хост — узкий вид `Repl`: только поля
 * истории и логгер; сама политика (кап, best-effort сейв) живёт здесь.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { Logger } from "../logger/app-logger";

/** Потолок истории по умолчанию (строк). */
export const DEFAULT_MAX_HISTORY = 1000;

/** Поля `Repl`, нужные истории. */
export interface ReplHistoryHost {
  historyPath: string;
  history: string[];
  maxHistory: number;
  logger?: Logger;
}

/** Грузит историю ввода из файла. */
export function loadHistory(host: ReplHistoryHost): void {
  if (existsSync(host.historyPath)) {
    try {
      const raw = readFileSync(host.historyPath, "utf-8");
      host.history = raw.split("\n").filter(Boolean).slice(-host.maxHistory);
    } catch {
      host.history = [];
    }
  }
}

/** Сохраняет историю ввода. Падение каталога переживает молча, не бросает. */
export function saveHistory(host: ReplHistoryHost): void {
  try {
    // Каталога истории может не быть (напр. temp снесли в тесте или при teardown
    // сессии). Пересоздаём; сейв бросать не должен никогда.
    mkdirSync(dirname(host.historyPath), { recursive: true });
    const allHistory = host.history.slice(-host.maxHistory);
    writeFileSync(host.historyPath, allHistory.join("\n"), "utf-8");
  } catch (e) {
    host.logger?.debug(`Failed to save REPL history: ${(e as Error).message}`);
  }
}

/** Строка ввода в историю (с капом): общая для очереди и гейта занятости. */
export function rememberInput(host: ReplHistoryHost, line: string): void {
  host.history.push(line);
  if (host.history.length > host.maxHistory) {
    host.history = host.history.slice(-host.maxHistory);
  }
}
