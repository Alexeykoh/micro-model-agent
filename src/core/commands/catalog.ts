// Декларативный каталог slash-команд: что существует, чему принадлежит, где доступно.
/**
 * Единый источник правды по slash-командам — «декларативная часть», отделённая
 * от действий. До этого описание команды жило в самом хендлере
 * (`registerCommand` в `src/cli/repl-commands.ts`), а группа — в ОТДЕЛЬНОЙ
 * таблице `COMMAND_GROUPS` из 29 строк, которую надо было синхронизировать
 * руками. `/help`, комплитер и `GET /api/commands` для браузера собирали свой
 * третий список.
 *
 * Теперь каталог объявляет, какая команда существует и где доступна, а действия
 * приклеиваются сверху через {@link CommandRegistry.bind}. Новый фронтенд
 * получает help, автодополнение и единый разбор алиасов из одного места, а
 * свои хендлеры реализует сам.
 *
 * Хендлеры при этом НЕ унифицированы: терминал печатает ANSI через
 * `OutputChannel`, браузер — plain-строки в SSE. Различие вывода живёт в
 * адаптерах (`CommandOutput`), каталог отвечает только за «что есть».
 */
import type { OutputStream } from "../../output/types";

/**
 * Фронтенд, на котором команда доступна. `tui` — терминальный класс (полноэкранный
 * терминал, но с теми же возможностями ввода-вывода), поэтому команда без явного
 * списка `surfaces` доступна и на REPL, и на TUI: см. {@link isAvailable}.
 */
export type CommandSurface = "terminal" | "tui" | "web";

/** Группа для `/help` и секций справки. */
export type CommandGroup = "general" | "agent" | "session" | "skill";

/**
 * Описание команды без действия. Хендлер приклеивается отдельно
 * ({@link CommandRegistry.bind}), поэтому описание переиспользуется всеми
 * фронтендами, а действие реализует каждый свой.
 */
export interface CommandSpec {
  /** Каноническое имя без ведущего слэша. */
  readonly name: string;
  /** Короткое описание (уже локализованное — резолвится при объявлении). */
  readonly description: string;
  readonly aliases?: readonly string[];
  readonly usage?: string;
  /** Короткие рабочие примеры для `/help <команда>`. */
  readonly examples?: readonly string[];
  readonly group?: CommandGroup;
  /**
   * Имя команды на вебе, если оно отличается от канонического. Сейчас такая
   * одна: `/sessions` (терминал, список) ↔ `/session` (браузер, `list|use`).
   * Нужна, чтобы `/help` и автодополнение браузера показывали реальное имя,
   * а не терминальное.
   */
  readonly webName?: string;
  /**
   * Где команда доступна. Без явного списка — терминальные поверхности
   * (`terminal`, `tui`). Список вида `["terminal", "tui", "web"]` означает «и
   * браузер тоже»; `["web"]` — команда только браузера.
   *
   * Нюанс: `/clear` и `/new` помечены `web`, но разбираются на КЛИЕНТЕ
   * (`assets/js/session/composer.ts`), а не серверным диспатчером, — поэтому
   * их нет в списке хендлеров `webui/chat/commands*.ts`. Тест сверки учитывает
   * это отдельно.
   */
  readonly surfaces?: readonly CommandSurface[];
}

/** Канал вывода команды: терминал, буфер TUI или SSE-строка. */
export type CommandWriter = (line: string, stream?: OutputStream) => void;

/** Действие команды. Получает аргументы и канал вывода своего фронтенда. */
export type CommandAction = (args: string[], out: CommandWriter) => void | Promise<void>;

/** Запись реестра: описание плюс, возможно, действие этого фронтенда. */
export interface CommandEntry extends CommandSpec {
  readonly action?: CommandAction;
}

/**
 * Доступна ли команда на поверхности.
 *
 * Без явного `surfaces` команда доступна на ВСЕХ терминальных поверхностях
 * (`terminal` и `tui`): будущий TUI получает тот же реестр целиком, а явный
 * список вида `["terminal", "web"]` означает «и браузер тоже».
 */
export function isAvailable(entry: CommandEntry, surface: CommandSurface): boolean {
  const declared = entry.surfaces;
  if (!declared) return surface !== "web";
  return declared.includes(surface);
}

/**
 * Реестр команд одного фронтенда: общий каталог описаний + свои действия.
 *
 * Ключи — каноническое имя и все алиасы, поэтому разбор ввода одинаков для
 * всех фронтендов. Описания переиспользуются (`CommandRegistry(catalog)`),
 * действия добавляются через `bind`: фронтенд объявляет, что он умеет.
 */
export class CommandRegistry {
  /** Ключ (имя или алиас) → каноническая запись. */
  private readonly index = new Map<string, CommandEntry>();
  /** Канонические имена в порядке объявления — для стабильного `/help`. */
  private readonly order: string[] = [];

  constructor(specs: readonly CommandSpec[] = []) {
    for (const spec of specs) this.add(spec);
  }

  /** Добавляет описание команды. Уже приклеенное действие сохраняется. */
  public add(spec: CommandSpec): void {
    const prev = this.index.get(spec.name);
    const entry: CommandEntry = { ...spec, action: prev?.action };
    this.set(entry);
  }

  /** Приклеивает действие фронтенда к команде (по имени или алиасу). */
  public bind(name: string, action: CommandAction): void {
    const canonical = this.index.get(stripSlash(name));
    if (!canonical) return;
    for (const [key, entry] of this.index) {
      if (entry.name === canonical.name) this.index.set(key, { ...entry, action });
    }
  }

  /** Резолв имени/алиаса в каноническую запись. */
  public resolve(name: string): CommandEntry | undefined {
    return this.index.get(stripSlash(name));
  }

  /** Канонические команды (без дублей алиасов), отсортированные по имени. */
  public list(surface?: CommandSurface): CommandEntry[] {
    const out: CommandEntry[] = [];
    for (const name of this.order) {
      const entry = this.index.get(name);
      if (!entry) continue;
      if (surface && !isAvailable(entry, surface)) continue;
      out.push(entry);
    }
    return out;
  }

  /** Есть ли команда, исполнимая этой поверхностью (для подсказки «unknown»). */
  public has(name: string, surface?: CommandSurface): boolean {
    const entry = this.resolve(name);
    return !!entry && (!surface || isAvailable(entry, surface));
  }

  private set(entry: CommandEntry): void {
    if (!this.order.includes(entry.name)) this.order.push(entry.name);
    this.index.set(entry.name, entry);
    for (const alias of entry.aliases ?? []) {
      this.index.set(alias, { ...entry, name: entry.name, aliases: undefined });
    }
  }
}

/**
 * Команды поверхности, сгруппированные для `/help` в порядке `order`.
 * Группы без команд пропускаются — пустые заголовки в справке не нужны.
 */
export function groupCommands(
  entries: readonly CommandEntry[],
  surface: CommandSurface,
  order: readonly CommandGroup[] = ["general", "agent", "session", "skill"],
): Array<{ group: CommandGroup; entries: CommandEntry[] }> {
  const out: Array<{ group: CommandGroup; entries: CommandEntry[] }> = [];
  for (const group of order) {
    const inGroup = entries.filter(
      (e) => (e.group ?? "general") === group && isAvailable(e, surface),
    );
    if (inGroup.length > 0) out.push({ group, entries: inGroup });
  }
  return out;
}

/**
 * Разбор строки ввода в имя + аргументы. Общий для всех фронтендов: ведущий
 * слэш и регистр отбрасываются, остаток режется по пробелам.
 */
export function parseCommandLine(line: string): { name: string; args: string[] } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts = trimmed.slice(1).trim().split(/\s+/).filter(Boolean);
  const name = (parts.shift() ?? "").toLowerCase();
  if (!name) return null;
  return { name, args: parts };
}

function stripSlash(name: string): string {
  return name.replace(/^\//, "").toLowerCase();
}