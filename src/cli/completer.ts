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

export interface CompletionProvider {
  name: string;
  match(ctx: CompletionContext): boolean;
  complete(ctx: CompletionContext): string[];
}

export class SlashCommandProvider implements CompletionProvider {
  name = "slash-commands";
  private commands: string[];

  constructor(commands: string[]) {
    this.commands = commands;
  }

  match(ctx: CompletionContext): boolean {
    return ctx.tokenIndex === 0 && ctx.line.startsWith("/");
  }

  complete(ctx: CompletionContext): string[] {
    return this.commands.filter((c) => c.startsWith(ctx.partial.slice(1))).map((c) => `/${c}`);
  }
}

export class SubcommandProvider implements CompletionProvider {
  name = "subcommands";
  private command: string;
  private subcommands: string[];

  constructor(command: string, subcommands: string[]) {
    this.command = command;
    this.subcommands = subcommands;
  }

  match(ctx: CompletionContext): boolean {
    return ctx.tokenIndex === 1 && ctx.tokens[0] === `/${this.command}`;
  }

  complete(ctx: CompletionContext): string[] {
    return this.subcommands.filter((s) => s.startsWith(ctx.partial));
  }
}

export class ModelArgProvider implements CompletionProvider {
  name = "model-args";
  private models: string[];

  constructor(models: string[]) {
    this.models = models;
  }

  match(ctx: CompletionContext): boolean {
    return ctx.tokenIndex === 2 && (ctx.tokens[0] === "/model" || ctx.tokens[0] === "/config");
  }

  complete(ctx: CompletionContext): string[] {
    return this.models.filter((m) => m.startsWith(ctx.partial));
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

  complete(ctx: CompletionContext): string[] {
    return this.keys.filter((k) => k.startsWith(ctx.partial));
  }
}

export class FilePathProvider implements CompletionProvider {
  name = "file-paths";

  match(ctx: CompletionContext): boolean {
    return ctx.partial.includes("/") || ctx.partial.includes("\\");
  }

  complete(ctx: CompletionContext): string[] {
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

      return matches.slice(0, 20);
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

  complete(ctx: CompletionContext): string[] {
    return this.providers.filter((p) => p.startsWith(ctx.partial));
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

  complete(ctx: CompletionContext): string[] {
    const names = this.getNames();
    if (!ctx.partial) return names;
    return names.filter((n) => n.toLowerCase().includes(ctx.partial.toLowerCase()));
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

  complete(ctx: CompletionContext): string[] {
    const subcmd = ctx.tokens[1];
    if (subcmd === "load") {
      const available = this.skillsModule.getAvailable();
      const names = available.map((s) => s.name);
      if (!ctx.partial) return names;
      return names.filter((n) => n.toLowerCase().includes(ctx.partial.toLowerCase()));
    }
    if (subcmd === "unload") {
      const loaded = this.skillsModule.getLoaded();
      const names = loaded.map((s) => s.name);
      if (!ctx.partial) return names;
      return names.filter((n) => n.toLowerCase().includes(ctx.partial.toLowerCase()));
    }
    return [];
  }
}

export class Completer {
  private providers: CompletionProvider[] = [];

  registerProvider(provider: CompletionProvider): void {
    this.providers.push(provider);
  }

  complete(line: string): [string[], string] {
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
