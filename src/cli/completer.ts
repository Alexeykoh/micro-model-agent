// Автокомплит REPL: slash-команды, субкоманды, модели, пути, ключи /config.
import type { SkillsModule } from "../modules/skills/module";
import { readdirSync, statSync } from "fs";
import { join } from "path";
import { allConfigNames, canonicalKeys, resolveConfigKey } from "../config/registry";
import { t } from "../i18n/index";

/** Контекст дополнения: строка, курсор, токены, partial, индекс токена. */
export interface CompletionContext {
  line: string;
  cursor: number;
  tokens: string[];
  partial: string;
  tokenIndex: number;
}

/** Вариант дополнения: значение + опц. описание. */
export interface CompletionItem {
  value: string;
  description?: string;
}

/** Провайдер дополнения: матчит позицию и отдаёт варианты. */
export interface CompletionProvider {
  name: string;
  match(ctx: CompletionContext): boolean;
  complete(ctx: CompletionContext): CompletionItem[];
}

/**
 * Строит slash-варианты из реестра команд. `commands` ключуется И каноническими
 * именами, И алиасами — каждый алиас становится дополняемым токеном с описанием
 * своей команды.
 */
export function buildSlashCompletions(
  commands: Map<string, { name: string; description: string }>,
): Array<{ name: string; description: string }> {
  return Array.from(commands.entries()).map(([name, cmd]) => ({
    name,
    description: cmd.description,
  }));
}

/** Дополняет slash-команды в позиции 0. */
export class SlashCommandProvider implements CompletionProvider {
  name = "slash-commands";
  private commands: Array<{ name: string; description?: string }>;

  constructor(commands: Array<{ name: string; description?: string }>) {
    this.commands = commands;
  }

  match(ctx: CompletionContext): boolean {
    return ctx.tokenIndex === 0 && ctx.line.startsWith("/");
  }

  complete(ctx: CompletionContext): CompletionItem[] {
    return this.commands
      .filter((c) => c.name.startsWith(ctx.partial.slice(1)))
      .map((c) => ({ value: `/${c.name}`, description: c.description }));
  }
}

/** Дополняет субкоманды (`/model use`, `/skill load`, …) в позиции 1. */
export class SubcommandProvider implements CompletionProvider {
  name = "subcommands";
  private command: string;
  private subcommands: Array<{ name: string; description?: string }>;

  constructor(
    command: string,
    subcommands: Array<{ name: string; description?: string }> | string[],
  ) {
    this.command = command;
    this.subcommands = subcommands.map((s) => (typeof s === "string" ? { name: s } : s));
  }

  match(ctx: CompletionContext): boolean {
    return ctx.tokenIndex === 1 && ctx.tokens[0] === `/${this.command}`;
  }

  complete(ctx: CompletionContext): CompletionItem[] {
    return this.subcommands
      .filter((s) => s.name.startsWith(ctx.partial))
      .map((s) => ({ value: s.name, description: s.description }));
  }
}

/** Дополняет имена моделей для `/model use`. */
export class ModelArgProvider implements CompletionProvider {
  name = "model-args";
  private getModels: () => string[];

  constructor(getModels: () => string[]) {
    this.getModels = getModels;
  }

  match(ctx: CompletionContext): boolean {
    return ctx.tokenIndex === 2 && ctx.tokens[0] === "/model" && ctx.tokens[1] === "use";
  }

  complete(ctx: CompletionContext): CompletionItem[] {
    return this.getModels()
      .filter((m) => m.startsWith(ctx.partial))
      .map((m) => ({ value: m }));
  }
}

/** Дополняет файловые пути (до 20 вариантов, каталоги со `/`). */
export class FilePathProvider implements CompletionProvider {
  name = "file-paths";
  private root?: string;

  constructor(root?: string) {
    this.root = root;
  }

  match(ctx: CompletionContext): boolean {
    return (
      ctx.tokenIndex >= 1 &&
      (ctx.partial.includes("/") || ctx.partial.includes("\\"))
    );
  }

  complete(ctx: CompletionContext): CompletionItem[] {
    try {
      const cwd = this.root ?? process.cwd();
      const partialPath = ctx.partial;
      const lastSlash = Math.max(partialPath.lastIndexOf("/"), partialPath.lastIndexOf("\\"));
      const dirPath = lastSlash > 0 ? partialPath.slice(0, lastSlash) : ".";
      const prefix = lastSlash > 0 ? partialPath.slice(0, lastSlash + 1) : "";

      const fullPath = join(cwd, dirPath);
      const entries = readdirSync(fullPath);

      const matches: string[] = [];
      for (const entry of entries) {
        const entryPath = join(fullPath, entry);
        const stat = statSync(entryPath);
        const completion = prefix + entry + (stat.isDirectory() ? "/" : "");

        if (completion.startsWith(ctx.partial)) {
          matches.push(completion);
        }
      }

      return matches.slice(0, 20).map((m) => ({ value: m }));
    } catch {
      return [];
    }
  }
}

/** Дополняет имена провайдеров для `/provider use`. */
export class ProviderArgProvider implements CompletionProvider {
  name = "provider-args";
  private providers: string[];

  constructor(providers: string[]) {
    this.providers = providers;
  }

  match(ctx: CompletionContext): boolean {
    return ctx.tokenIndex === 2 && ctx.tokens[0] === "/provider" && ctx.tokens[1] === "use";
  }

  complete(ctx: CompletionContext): CompletionItem[] {
    return this.providers.filter((p) => p.startsWith(ctx.partial)).map((p) => ({ value: p }));
  }
}

/** Дополняет имена сессий для `/resume` и др. */
export class SessionNameProvider implements CompletionProvider {
  name = "session-names";
  private getNames: () => string[];
  private commands: string[];

  constructor(getNames: () => string[], commands: string[] = ["/resume"]) {
    this.getNames = getNames;
    this.commands = commands;
  }

  match(ctx: CompletionContext): boolean {
    return ctx.tokenIndex >= 1 && this.commands.includes(ctx.tokens[0]);
  }

  complete(ctx: CompletionContext): CompletionItem[] {
    const names = this.getNames();
    const filtered = !ctx.partial
      ? names
      : names.filter((n) => n.toLowerCase().includes(ctx.partial.toLowerCase()));
    return filtered.map((n) => ({ value: n }));
  }
}

/** Дополняет имена скиллов для `/skill load|unload`. */
export class SkillNameProvider implements CompletionProvider {
  name = "skill-names";
  private skillsModule: SkillsModule;

  constructor(skillsModule: SkillsModule) {
    this.skillsModule = skillsModule;
  }

  match(ctx: CompletionContext): boolean {
    return (
      ctx.tokenIndex >= 2 &&
      ctx.tokens[0] === "/skill" &&
      (ctx.tokens[1] === "load" || ctx.tokens[1] === "unload")
    );
  }

  complete(ctx: CompletionContext): CompletionItem[] {
    const sources: Record<string, () => string[]> = {
      load: () => this.skillsModule.getAvailable().map((s) => s.name),
      unload: () => this.skillsModule.getLoaded().map((s) => s.name),
    };
    const source = sources[ctx.tokens[1]];
    if (!source) return [];
    const names = source();
    const filtered = !ctx.partial
      ? names
      : names.filter((n) => n.toLowerCase().includes(ctx.partial.toLowerCase()));
    return filtered.map((n) => ({ value: n }));
  }
}

/**
 * Дополняет ключи `/config` (канонические и алиасы). Partial без точки листает
 * верхние группы + подходящие ключи; partial с точкой — следующий сегмент
 * точечного дерева (напр. `contextBudget.` → systemPrompt).
 */
export class ConfigKeyProvider implements CompletionProvider {
  name = "config-keys";

  match(ctx: CompletionContext): boolean {
    return ctx.tokenIndex === 1 && ctx.tokens[0] === "/config";
  }

  complete(ctx: CompletionContext): CompletionItem[] {
    const partial = ctx.partial;
    const items: CompletionItem[] = allConfigNames().map(({ name, def, alias }) => ({
      value: name,
      description: alias ? `${t("config.alias_label")} ${def.key}` : def.domain,
    }));
    if (!partial.includes(".")) {
      const groups = [...new Set(canonicalKeys().filter((k) => k.includes(".")).map((k) => k.split(".")[0]))];
      const groupItems: CompletionItem[] = groups.map((g) => ({
        value: g,
        description: t("config.group_label"),
      }));
      return [...groupItems, ...items].filter((i) => i.value.startsWith(partial));
    }
    return items.filter((i) => i.value.startsWith(partial));
  }
}

/** Дополняет enum-значения в позиции значения `/config <ключ> <значение>`. */
export class ConfigValueProvider implements CompletionProvider {
  name = "config-values";

  match(ctx: CompletionContext): boolean {
    return ctx.tokenIndex === 2 && ctx.tokens[0] === "/config";
  }

  complete(ctx: CompletionContext): CompletionItem[] {
    const def = resolveConfigKey(ctx.tokens[1]);
    if (!def?.enumValues) return [];
    return def.enumValues
      .filter((v) => v.startsWith(ctx.partial))
      .map((v) => ({ value: v }));
  }
}

/** Дополняет флаги `/provider add`. */
export class FlagProvider implements CompletionProvider {
  name = "provider-add-flags";

  match(ctx: CompletionContext): boolean {
    return ctx.tokens[0] === "/provider" && ctx.tokens[1] === "add" && ctx.tokenIndex >= 2;
  }

  complete(ctx: CompletionContext): CompletionItem[] {
    const flags: CompletionItem[] = [
      { value: "--url", description: t("repl.provider_flag_url") },
      { value: "--key", description: t("repl.provider_flag_key") },
      { value: "--priority", description: t("repl.provider_flag_priority") },
      { value: "--context-window", description: t("repl.provider_flag_context_window") },
      { value: "--rpm", description: t("repl.provider_flag_rpm") },
      { value: "--parallel", description: t("repl.provider_flag_parallel") },
    ];
    return flags.filter((f) => f.value.startsWith(ctx.partial));
  }
}

/** Дополняет имена команд для `/help <команда>`. */
export class CommandArgProvider implements CompletionProvider {
  name = "help-command-args";
  private getNames: () => string[];

  constructor(getNames: () => string[]) {
    this.getNames = getNames;
  }

  match(ctx: CompletionContext): boolean {
    return ctx.tokenIndex === 1 && ctx.tokens[0] === "/help";
  }

  complete(ctx: CompletionContext): CompletionItem[] {
    return this.getNames()
      .filter((n) => n.startsWith(ctx.partial))
      .map((n) => ({ value: n }));
  }
}

/** Комплитер: гоняет ввод через провайдеров, первый с хитами побеждает. */
export class Completer {
  private providers: CompletionProvider[] = [];

  /** Регистрирует провайдера. */
  registerProvider(provider: CompletionProvider): void {
    this.providers.push(provider);
  }

  /** Сброс всех провайдеров — перед пересборкой (напр. /reload), чтобы
   *  перерегистрация не копила дубликаты. */
  reset(): void {
    this.providers = [];
  }

  /** Дополняет строку; возвращает [варианты, partial]. */
  complete(line: string): [CompletionItem[], string] {
    const cursor = line.length;
    const tokens = line.split(/\s+/);
    const partial = tokens[tokens.length - 1] || "";
    const tokenIndex = tokens.length - 1;

    const ctx: CompletionContext = { line, cursor, tokens, partial, tokenIndex };

    for (const provider of this.providers) {
      if (provider.match(ctx)) {
        const results = provider.complete(ctx);
        if (results.length > 0) {
          return [results, partial];
        }
      }
    }

    return [[], partial];
  }
}
