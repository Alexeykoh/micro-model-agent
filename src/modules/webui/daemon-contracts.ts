/**
 * Контракт демона для web-адаптера (split W4).
 *
 * `RemoteHost` удовлетворяет ему структурно; web-модуль не импортирует
 * `modules/daemon`, чтобы не появлялось ребро module→module.
 */
import type { Host } from "../../core/host";

/** Дополнительные методы, которые нужны браузерной поверхности. */
export interface WebDaemonHost extends Host {
  pause(): Promise<void>;
  resume(): Promise<void>;
  answer(id: string, value: unknown): Promise<void>;
  setSessionId(sessionId: string): void;
  /** Листинг директории workspace (панель Files). */
  listFiles(path: string): Promise<unknown>;
  gitSnapshot(): Promise<unknown>;
  gitChanges(): Promise<unknown>;
  gitDiff(path: string, staged: boolean): Promise<unknown>;
  memory(): Promise<unknown>;
  skills(): Promise<unknown>;
  setup(): Promise<unknown>;
  reindex(): Promise<unknown>;
  lspFlags(): Promise<unknown>;
  lspDoctor(): Promise<unknown>;
  plugins(): Promise<unknown>;
  installUpdate(): Promise<unknown>;
  /** Байты сохранённой картинки тула (панель/лента в daemon-режиме). */
  readImage(
    sessionId: string,
    name: string,
  ): Promise<{ bytes: Uint8Array; mime: string } | null>;
  /** Системный промпт активного раннера сессии. */
  sessionPrompt(sessionId: string): Promise<unknown>;
  /** Журнал защиты сессии (буфер + audit.jsonl). */
  sessionSecurity(sessionId: string, limit?: number): Promise<unknown>;
  /** Снимки прогонов субагентов сессии. */
  subagentRuns(sessionId: string, toolCallId?: string): Promise<unknown>;
  /** Остановить прогон субагента. */
  interruptSubagent(sessionId: string, runId: string): Promise<unknown>;
  /** Поиск по workspace (панель Files / `@`-mentions). */
  search(query: string, namesOnly: boolean): Promise<unknown>;
  dispose(): void;
}
