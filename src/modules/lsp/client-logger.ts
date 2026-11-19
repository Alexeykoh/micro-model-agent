// Логгер LSP-клиента. Интерфейс вынесен из `client.ts`, чтобы транспорт
// (`connection.ts`) и фасад (`client.ts`) зависели от контракта, а не друг от
// друга.

/** Логгер клиента (интерфейс). */
export interface LspClientLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Логгер-адаптер: LSP-диагностику только в app.jsonl, никогда в консоль/терминал.
 * LSP-предупреждения шумные (таймаут на первом запуске, установка npx) и должны
 * диагностироваться из файлов сессии, не мусор в чате пользователя.
 */
export class FileOnlyLogger implements LspClientLogger {
  constructor(private logger: { logSilent(level: string, msg: string, meta?: Record<string, unknown>): void }) {}

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.logger.logSilent("debug", msg, meta);
  }
  info(msg: string, meta?: Record<string, unknown>): void {
    this.logger.logSilent("info", msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.logger.logSilent("warn", msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.logger.logSilent("error", msg, meta);
  }
}
