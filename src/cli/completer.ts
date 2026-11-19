// Автокомплит REPL: движок провайдеров. Конкретные провайдеры — в
// `./completer-providers` (правило ≤300).
import type {
  CompletionContext,
  CompletionItem,
  CompletionProvider,
} from "./completer-providers";
import { t } from "../i18n/index";

// Провайдеры/типы живут в `./completer-providers`; реэкспорт для импортёров.
export * from "./completer-providers";

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

  /**
   * Дополняет строку; возвращает [варианты, partial].
   *
   * `cursor` — позиция курсора в строке (по умолчанию конец): дополняется токен
   * ПОД КУРСОРОМ, а не последний в строке (аудит §8.15).
   */
  complete(line: string, cursor: number = line.length): [CompletionItem[], string] {
    const pos = Math.max(0, Math.min(cursor, line.length));
    const before = line.slice(0, pos);
    const tokens = before.split(/\s+/);
    const partial = tokens[tokens.length - 1] || "";
    const tokenIndex = tokens.length - 1;

    const ctx: CompletionContext = { line, cursor: pos, tokens, partial, tokenIndex };

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
