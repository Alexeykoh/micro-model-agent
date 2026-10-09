// Контракты контекста команд: сервисная часть (фронтендонезависимая) и ввод/вывод.
/**
 * Рефакторинг `ReplContext` (бывший единый интерфейс на 20 членов в
 * `src/cli/repl-commands.ts`). Он смешивал две разные вещи:
 *
 *  1. **Сервисы** — конфиг, агент, модули, каталоги. Фронтендонезависимы:
 *     одинаково нужны REPL, TUI, web и serve.
 *  2. **Ввод/вывод** — `rl` (`LineInput`) и `output` (`OutputChannel`). Это
 *     про ОДНОКРАТНЫЙ построчный терминал; TUI перерисовывает кадр и не имеет
 *     `LineInput` в этом смысле.
 *
 * Разделение даёт третьему фронтенду корень: реализовать {@link CommandIO}
 * (вывод + ввод) — и весь реестр команд становится доступен без правок.
 * Сервисная часть ({@link CommandServices}) остаётся общей.
 *
 * Именование `CommandServices` вместо исторического `ReplContext`, чтобы
 * новый фронтенд не наследовал имя терминала.
 */
import type { LineInput } from "../ui/line-editor";
import type { Agent } from "../core/agent";
import type { AppConfig } from "../config/types";
import type { SessionManager } from "../modules/session/manager";
import type { SkillsModule } from "../modules/skills/module";
import type { PluginManager } from "../modules/plugins/manager";
import type { ToolContext } from "../tools/types";
import type { OutputStream } from "../output/types";
import type { PromptInput } from "./setup-prompt";

/**
 * Вывод команды — единственное, что команда знает о фронтенде.
 *
 * Узкий срез `OutputChannel`: терминал печатает в канал, TUI — в буфер
 * панели/очереди ленты, web — в SSE-событие `command`. Полный
 * `OutputChannel` командам не нужен: модель режимов (`idle`/`streaming`/
 * `modal`) — забота самого фронтенда, а не команды.
 */
export interface CommandOutput {
  writeLine(text: string, stream?: OutputStream): void;
  clearScreen(): void;
  /**
   * Перезаписываемая оверлей-строка (спиннер «загрузка моделей»). Опциональна:
   * фронтенд без оверлеев (лента в TUI) просто не показывает анимацию.
   */
  writeOverlay?(text: string): void;
  /**
   * Живые тумблеры видимости внутренних info-логов и диагностик петли.
   * Не все фронтенды их показывают (TUI рисует логи в панели), поэтому
   * методы опциональны и по умолчанию игнорируются.
   */
  setSuppressInfoLogs?(suppress: boolean): void;
  setShowDiagnostics?(show: boolean): void;
}

/**
 * Ввод команды — то, что нужно интерактивным командам (сейчас `/config
 * reset --all` и `/wizard`). Отделён от `LineInput`: TUI реализует его через
 * свой фокус/оверлей, не подсовывая чужой построчный редактор.
 */
export interface CommandInput {
  /**
   * Выполняет `fn`, владея вводом. `prompt` — источник вопросов для диалога.
   *
   * Нужен визарду `/wizard`: он печатает меню через `OutputChannel`, и пока
   * терминал не отдан ему целиком, эти строки уходят в `printAbove` поверх
   * живой строки ввода, а пользователь видит голые `: `. Владение вводом —
   * забота ФРОНТЕНДА (терминал гасит кадр промпта, TUI поднимает оверлей),
   * поэтому контракт здесь, а не в команде.
   */
  withInput<T>(fn: (prompt: PromptInput) => Promise<T>): Promise<T>;
  /**
   * Одиночный вопрос по ходу обычной команды (не визард). Терминал на время
   * одалживает кадр промпта; ответ приходит строкой.
   */
  question(prompt: string): Promise<string>;
  /** Одиночное подтверждение yes/no. */
  confirm(prompt: string): Promise<boolean>;
}

/** Ввод/вывод команды как единый шов к фронтенду. */
export interface CommandIO {
  readonly input: CommandInput;
  readonly output: CommandOutput;
}

/**
 * Сервисная часть контекста команд. Не знает про терминал, TUI, SSE или
 * HTTP — только про конфиг, агента и модули. Именно её реализует каждый
 * фронтенд (REPL сейчас, TUI/web/serve дальше).
 */
export interface CommandServices {
  readonly config: AppConfig;
  readonly agent: Agent;
  /** Общий контекст тулов: несёт состояние скоупа режима (allowlist, онбординг). */
  readonly toolCtx: ToolContext;
  readonly sessionManager?: SessionManager;
  readonly skillsModule?: SkillsModule;
  readonly pluginManager?: PluginManager;
  readonly configDir: string;
  readonly baseDir: string;
  runAgent(input: string): Promise<void>;
  showHelp(command?: string): void;
  /** Перестройка реестра команд + комплитера (после смены локали). */
  reregisterCommands(): void;
  /** Boot-снапшот управляемых ключей для `/config reset`. */
  getConfigSnapshot(): ReadonlyMap<string, unknown>;
  /** Кешированные id моделей активного провайдера (пусто, если офлайн). */
  knownModels(): string[];
  refreshModelCache(): void;
  attachHostBridge(pluginManager?: PluginManager): void;
  /** Перезагрузка агента и модулей (команда `/reload`). */
  reload(): Promise<void>;
  stop(): void;
}

/**
 * Полный контекст команды = сервисы + ввод/вывод + саморегистрация.
 * Форма команд при рефакторинге не изменилась — команды обращаются к тем же
 * полям, REPL собирает объединение из сервисов и своего терминального ввода-вывода.
 */
export interface CommandContext extends CommandServices, CommandIO {
  registerCommand(cmd: {
    name: string;
    description: string;
    aliases?: string[];
    usage?: string;
    examples?: string[];
    action(args: string[]): void | Promise<void>;
  }): void;
  /** Пересборка комплитера (терминальная деталь, нужна `Repl`). */
  setupCompleter(): void;
}

/**
 * Историческое имя контекста терминала. Остаётся алиасом `CommandContext`,
 * чтобы не чинить существующие импорты `src/cli/onboarding-commands.ts`,
 * `repl-commands-lsp.ts`, `repl-commands-skills.ts` и тесты.
 */
export type ReplContext = CommandContext;

/**
 * Адаптер терминального ввода → {@link CommandInput} для REPL.
 *
 * `question` — одиночный вопрос тула/команды: одалживает терминал (см.
 * `Repl.askViaEditor`: снимает кадр промпта, включает ввод, по завершении
 * возвращает стрим агента).
 *
 * `withInput` — терминал целиком отдан callback'у на время `fn`: между
 * вопросами активного кадра нет, и меню/вывод визарда должны печататься
 * напрямую (`inputLocked` гасит `promptSink.isActive()`), а не через
 * `printAbove` поверх живой строки ввода. `exclusive` — терминальная
 * реализация этого владения (`Repl.withExclusiveInput`).
 */
export function createCommandInput(
  rl: LineInput,
  ask: (prompt: string) => Promise<string>,
  exclusive: <T>(fn: () => Promise<T>) => Promise<T>,
): CommandInput {
  return {
    withInput: (fn) => exclusive(() => fn(rl)),
    question: ask,
    async confirm(prompt: string): Promise<boolean> {
      const answer = await ask(prompt);
      return /^y(es)?$/i.test(answer.trim());
    },
  };
}