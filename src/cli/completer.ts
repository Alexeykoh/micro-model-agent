import type { SkillsModule } from "../modules/skills/module";
import { readdirSync, statSync } from "fs";
import { join } from "path";

export interface CompletionContext {
  line: string;
  cursor: number;
  tokens: string[];
  partial: string;
  tokenIndex: number;
}

export interface CompletionItem {
  value: string;
  description?: string;
}

export interface CompletionProvider {
  name: string;
  match(ctx: CompletionContext): boolean;
  complete(ctx: CompletionContext): CompletionItem[];
}

/**
 * Build slash-completion items from the command registry. `commands` is keyed
 * by canonical name AND aliases, so every alias becomes a completable token
 * carrying its command's description.
 */
export function buildSlashCompletions(
  commands: Map<string, { name: string; description: string }>,
): Array<{ name: string; description: string }> {
  return Array.from(commands.entries()).map(([name, cmd]) => ({
    name,
    description: cmd.description,
  }));
}

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

export class ConfigKeyProvider implements CompletionProvider {
  name = "config-keys";
  private keys: string[];

  constructor(keys: string[]) {
    this.keys = keys;
  }

  match(ctx: CompletionContext): boolean {
    return ctx.tokenIndex >= 1 && ctx.tokens[0] === "/config" && ctx.tokens[1] === "set";
  }

  complete(ctx: CompletionContext): CompletionItem[] {
    return this.keys.filter((k) => k.startsWith(ctx.partial)).map((k) => ({ value: k }));
  }
}

export class FilePathProvider implements CompletionProvider {
  name = "file-paths";

  match(ctx: CompletionContext): boolean {
    return ctx.partial.includes("/") || ctx.partial.includes("\\");
  }

  complete(ctx: CompletionContext): CompletionItem[] {
    try {
      const cwd = process.cwd();
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

export class SessionNameProvider implements CompletionProvider {
  name = "session-names";
  private getNames: () => string[];

  constructor(getNames: () => string[]) {
    this.getNames = getNames;
  }

  match(ctx: CompletionContext): boolean {
    return ctx.tokenIndex >= 1 && ctx.tokens[0] === "/resume";
  }

  complete(ctx: CompletionContext): CompletionItem[] {
    const names = this.getNames();
    const filtered = !ctx.partial
      ? names
      : names.filter((n) => n.toLowerCase().includes(ctx.partial.toLowerCase()));
    return filtered.map((n) => ({ value: n }));
  }
}

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

export class Completer {
  private providers: CompletionProvider[] = [];

  registerProvider(provider: CompletionProvider): void {
    this.providers.push(provider);
  }

  /** Drop all registered providers — used before a rebuild (e.g. /reload)
   *  so re-registering never accumulates duplicates. */
  reset(): void {
    this.providers = [];
  }

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
