// Опции менеджера сессий (вынесено из manager.ts, правило 6).
import type { SessionEncryptionConfig } from "../../config/types";
import type { SessionIsolationConfig } from "../../modules/security/session-isolation";

/** Опции менеджера сессий. */
export interface SessionManagerOptions {
  model: string;
  contextWindow: number;
  projectDir: string;
  maxSessions?: number;
  /** Конфиг изоляции сессий */
  isolation?: SessionIsolationConfig;
  /** Конфиг шифрования файлов сессий */
  encryption?: SessionEncryptionConfig;
  /** Логгер для фоновой автоочистки (необязательный: тесты/утилиты). */
  logger?: { warn(message: string): void };
}
