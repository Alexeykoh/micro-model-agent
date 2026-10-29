/**
 * Контракты плагинов и хост-моста агента: модули, хуки жизненного цикла,
 * мост для управления прогоном из хоста (REPL/веб).
 */
import type { PromptBlock, AgentPhase, LLMResponse } from "../core/types";
import type { ToolDefinition, ToolCall, ToolResult } from "../tools/types";
import type { OutputEvent } from "../output/types";

export interface AgentModule {
  name: string;
  getSystemPromptBlock?(): PromptBlock | null;
  getToolDefinitions?(): ToolDefinition[];
  getPlugin?(): AgentPlugin;
}

export interface HostBridgeSubmitOptions {
  /** Data URL картинок к сообщению (`data:image/png;base64,...`). */
  images?: string[];
}

/**
 * Узкий API, который хост (REPL) отдаёт плагинам для управления агентом.
 * Регистрируется через `PluginManager.setHostBridge()` и подмешивается в
 * контекст каждого хука как `ctx.hostBridge`. Отсутствует в single-run
 * режиме и тестах без хоста.
 */
export interface HostBridge {
  /** True, пока агент обрабатывает ход. */
  isBusy(): boolean;
  /**
   * Отправить сообщение пользователя штатным входным путём хоста (как ввод
   * в REPL). Отклоняется, если агент занят. Резолвится по концу хода.
   */
  submit(text: string, opts?: HostBridgeSubmitOptions): Promise<unknown>;
  /** Прервать текущий прогон (no-op в простое). */
  interrupt(): void;
  /**
   * Подписка на шину вывода хоста (warn/error-логи, пробы провайдера).
   * Возвращает функцию отписки. Опционально, чтобы жили тестовые стабы.
   */
  subscribeOutput?(fn: (ev: OutputEvent) => void): () => void;
}

/** Итог завершённого прогона агента, передаётся в `AgentPlugin.onTurnEnd`. */
export interface TurnSummary {
  success: boolean;
  durationMs: number;
  textLength: number;
  toolCalls: number;
  interrupted?: boolean;
}

/**
 * Права, которые плагин **декларирует** для показа пользователю. Это описание
 * намерений, а не enforcement: код плагина исполняется в процессе агента и
 * де факто имеет те же возможности, что и харнесс (см. `docs/plugins.md`).
 */
export type PluginPermission =
  | "config:read"
  | "fs:read"
  | "fs:write"
  | "process"
  | "network"
  | "session:write";

/** Что плагин добавляет в харнесс (для UI и `mma plugins list`). */
export interface PluginProvides {
  /** Имена тулов, которые плагин отдал через `getToolDefinitions()`. */
  tools?: string[];
  /** Имена реализованных хуков; вычисляется ядром при регистрации. */
  hooks?: string[];
}

export interface AgentPlugin {
  name: string;
  priority?: number;
  isBuiltin?: boolean;
  /**
   * Системный хук модуля харнесса (`execution`, `lsp-check`, `session`,
   * `indexer` …), а не пользовательский плагин. Он не показывается как плагин
   * и не отключается из UI/CLI: код модуля уже загружен, а его выключение
   * меняет поведение харнесса, а не «выгружает плагин».
   */
  system?: boolean;
  /** Semver-версия плагина. Для дедупа (выигрывает старшая) и `mma plugins list`. */
  version?: string;
  /** Минимальная semver-версия MMA для запуска плагина. Несовместимые пропускаются загрузчиком. */
  minMmaVersion?: string;
  /** Откуда плагин: "builtin" | "global" | "project". Проставляет загрузчик/регистрация. */
  source?: "builtin" | "global" | "project";
  /** Человеческое описание (1–2 строки) — показывается в UI и листингах. */
  description?: string;
  /** Автор или организация. */
  author?: string;
  /** Домашняя страница/репозиторий. Только http(s), иначе отбрасывается. */
  homepage?: string;
  /** Права, которые плагин запрашивает (только декларация и показ). */
  permissions?: PluginPermission[];
  /** Что добавляет. `tools` заполняется ядром, `hooks` вычисляется при регистрации. */
  provides?: PluginProvides;
  /** Абсолютный путь к файлу плагина; проставляет загрузчик. */
  path?: string;
  /**
   * Тулы, которые плагин добавляет в харнесс (зеркалит `AgentModule`).
   *
   * Имя из определения **не** используется как есть: в реестр тул попадает под
   * `plugin__<плагин>__<тул>` (`pluginToolName`), получает тег `plugin:<плагин>`
   * и `alwaysOn: true` по умолчанию — иначе `enable_tools` спрятал бы его под
   * любым `enable_tools`. Коллизия имён с ядром или другим плагином отбрасывает
   * весь вклад плагина (см. `plugins/tools.ts`).
   *
   * Хуки при этом продолжают работать: тело плагина уже исполняется, а вклад в
   * тулы — самая безобидная часть.
   */
  getToolDefinitions?(): ToolDefinition[];
  /** Добавить блок в системный промпт (выполняется один раз при построении). */
  onBuildPrompt?(): string | null;
  /**
   * Вернуть `false`, чтобы заблокировать вызов тула до исполнения, или строку —
   * заблокировать с явной причиной, видимой модели.
   */
  onBeforeTool?(ctx: any, call: ToolCall): boolean | string | Promise<boolean | string>;
  /** Выполняется после тула; может мутировать `result.output`. */
  onAfterTool?(ctx: any, call: ToolCall, result: ToolResult): void | Promise<void>;
  /** Перед каждым вызовом LLM. */
  onBeforeThink?(ctx: any): void;
  /** После ответа LLM; получает распарсенный ответ. */
  onAfterThink?(ctx: any, response: LLMResponse | null): void;
  /** Когда LLM вернула вызов тула. */
  onToolCall?(ctx: any): void;
  onError?(ctx: any, error: Error): void;
  onSessionStart?(ctx: any): void;
  onSessionEnd?(ctx: any): void;
  /** Жизненный цикл спиннера thinking: 'thinking' | 'done'. */
  onPhase?(ctx: any, phase: AgentPhase): void;
  /** Карточка тула открыта (до исполнения). */
  onToolStart?(ctx: any, call: ToolCall): void;
  /** Карточка тула закрыта (после исполнения, с длительностью). */
  onToolEnd?(ctx: any, call: ToolCall, result: ToolResult, durationMs: number): void;
  /** Трансформация/фильтр стримленного текста модели; строка — замена, undefined — пропустить. */
  onText?(ctx: any, chunk: string): string | undefined;
  /** Трансформация/фильтр стримленной меты (reasoning + вывод тулов); строка — замена, undefined — пропустить. */
  onMeta?(ctx: any, chunk: string): string | undefined;
  /** Вызывается один раз по завершении `run()` агента (финальный ответ, ошибка или прерывание). */
  onTurnEnd?(ctx: any, summary: TurnSummary): void;
  /**
   * Вызывается при выгрузке плагина (перезагрузка каталога, `/reload`) —
   * освободить ресурсы: закрыть серверы, снять таймеры.
   *
   * Без этого хука перезагрузка течёт: `examples/plugins/web-ui` поднимает
   * HTTP-сервер в `onSessionStart`, и копии накапливаются.
   */
  onUnload?(ctx?: any): void | Promise<void>;
}
