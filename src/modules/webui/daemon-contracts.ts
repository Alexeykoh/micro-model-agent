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
  setupApply(answers: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  setupScan(): Promise<unknown>;
  setupModels(input: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  setupTest(input: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  setupContext(input: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  setupLocale(locale: string): Promise<{ status: number; body: unknown }>;
  reindex(): Promise<unknown>;
  lspServers(): Promise<unknown>;
  lspDoctorGet(): Promise<unknown>;
  lspDoctorRun(): Promise<{ status: number; body: unknown }>;
  lspCheck(path: string): Promise<{ status: number; body: unknown }>;
  lspCheckChanged(): Promise<{ status: number; body: unknown }>;
  lspUpdate(lang: string, patch: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
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
  /** Каталог команд с признаком исполняемости на проводе. */
  commands(): Promise<unknown>;
  /** Вьюер файла: статус, mime и байты. */
  fileView(path: string, download: boolean): Promise<{ status: number; mime: string; bytes: Uint8Array }>;
  /** Очередь сессии. */
  queue(sessionId: string): Promise<{ queued: number; ids: string[] }>;
  /** Провайдеры: список/добавление-правка/удаление. */
  providers(): Promise<unknown>;
  saveProvider(input: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  deleteProvider(name: string): Promise<{ status: number; body: unknown }>;
  /** MCP: список и CRUD настроенных серверов. */
  mcpList(): Promise<unknown>;
  mcpCreate(input: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  mcpToggle(id: string, enabled: boolean): Promise<{ status: number; body: unknown }>;
  mcpUpdate(id: string, patch: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  mcpDelete(id: string): Promise<{ status: number; body: unknown }>;
  /** Память: добавление и удаление записи. */
  memoryAdd(category: string, text: string): Promise<{ status: number; body: unknown }>;
  memoryDelete(category: string, n: number): Promise<{ status: number; body: unknown }>;
  /** Плагины: тумблер, настройки, reload. */
  pluginToggle(name: string, enabled: boolean): Promise<{ status: number; body: unknown }>;
  pluginSettingsGet(name: string): Promise<{ status: number; body: unknown }>;
  pluginSettingsPut(
    name: string,
    values: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }>;
  pluginsReload(): Promise<{ status: number; body: unknown }>;
  /** Действие очереди (`cancel|edit|start`). */
  queueAction(
    sessionId: string,
    action: "cancel" | "edit" | "start",
    id: string,
    text?: string,
  ): Promise<{ status: number; body: unknown }>;
  dispose(): void;
}
