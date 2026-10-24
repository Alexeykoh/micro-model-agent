// Общие стабы для тестов, конструирующих `Repl` напрямую.
/**
 * `Repl` принимает 15 позиционных аргументов, из которых тестам нужны лишь
 * агент, конфиг, путь истории и канал вывода. Здесь собраны стабы, чтобы новый
 * тест не копировал ~30 строк фикстуры (fallow уже показывал клон из трёх
 * копий `makeAgent`/`makeConfig`).
 */
import { Repl } from "../../src/cli/repl";

/** Минимальный агент: `run` возвращает успешный результат, всё остальное — no-op. */
export function stubAgent(overrides?: Record<string, unknown>) {
  return {
    run: async () => ({ success: true, text: "ok", provider: "p", model: "m", durationMs: 1 }),
    shutdown: () => {},
    getProviderFor: () => undefined,
    tryToolContext: () => undefined,
    ...overrides,
  } as never;
}

/** Минимальный `AppConfig` с валидными бюджетами контекста. */
export function stubConfig() {
  return {
    model: "test",
    provider: { type: "test", baseUrl: "test", apiKey: "test" },
    contextWindow: 32768,
    contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 },
    logLevel: "info",
    locale: "en",
    maxToolIterations: 25,
    stuckThreshold: 8,
    autoPlan: true,
    showReasoning: false,
    ui: {},
    session: { autoSave: false, maxSessions: 50, isolateMemory: false },
  } as never;
}

/**
 * Конструирует `Repl` с пустыми модулями (нет `sessionManager`/`skillsModule`),
 * поэтому регистрируются только команды, не требующие модулей, — см.
 * `registerSessionCommands`/`registerSkillCommands`.
 */
export function makeBareRepl(args: {
  channel: ConstructorParameters<typeof Repl>[14];
  historyPath: string;
  /** Переопределить заглушку агента (например, чтобы проверить вызовы provider). */
  agent?: Record<string, unknown>;
  /** Переопределить конфиг (например, мультипровайдерную раскладку entries). */
  config?: Record<string, unknown>;
}): Repl {
  return new Repl(
    (args.agent ?? stubAgent()) as never,
    (args.config ?? stubConfig()) as never,
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, args.historyPath,
    undefined, undefined, args.channel,
  );
}