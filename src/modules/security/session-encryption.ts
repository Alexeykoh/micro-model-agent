// Шифрование файлов сессий (history.jsonl, session.jsonl): чтение/запись/append.
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import {
  encryptString,
  decryptString,
  isEncryptedString,
  ConfigEncryptor,
} from "./encryption";
import { defaultOutputBus } from "../../output";
import { globalMmaDir } from "../../config/paths";

/** Конфиг шифрования файлов сессии. */
export interface SessionEncryptionConfig {
  /** Включить шифрование файлов сессии */
  enabled: boolean;
  /** Шифровать history.jsonl */
  encryptHistory: boolean;
  /** Шифровать session.jsonl */
  encryptSessionLog: boolean;
  /** Кастомный путь ключа (опционально) */
  keyPath?: string;
}

/** Дефолтный конфиг шифрования сессии (выключено). */
export const DEFAULT_SESSION_ENCRYPTION: SessionEncryptionConfig = {
  enabled: false,
  encryptHistory: true,
  encryptSessionLog: true,
};

/** Шифровальщик/расшифровщик файлов сессии. */
export class SessionFileEncryptor {
  private config: SessionEncryptionConfig;
  private encryptor: ConfigEncryptor;

  constructor(config?: Partial<SessionEncryptionConfig>) {
    this.config = { ...DEFAULT_SESSION_ENCRYPTION, ...config };
    this.encryptor = new ConfigEncryptor({
      keyPath: config?.keyPath || join(globalMmaDir(), ".session-encryption-key"),
    });
  }

  /** Включено ли шифрование файлов сессии. */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /** Зашифровать содержимое файла сессии. */
  encryptFileContent(content: string): string {
    if (!this.config.enabled) return content;
    return encryptString(content, this.encryptor.getKey());
  }

  /** Расшифровать содержимое файла сессии (plain text — как есть). */
  decryptFileContent(content: string): string {
    if (!this.config.enabled) return content;
    if (!isEncryptedString(content)) return content;
    return decryptString(content, this.encryptor.getKey());
  }

  /** Зашифровать JSON-объект (для структурных файлов). */
  encryptJSON<T>(obj: T): string {
    if (!this.config.enabled) return JSON.stringify(obj);
    return this.encryptFileContent(JSON.stringify(obj));
  }

  /** Расшифровать JSON-строку; мусор — ошибка. */
  decryptJSON<T>(content: string): T {
    let plain = content;
    if (this.config.enabled) {
      plain = this.decryptFileContent(content);
    }
    try {
      return JSON.parse(plain) as T;
    } catch {
      throw new Error(
        "Invalid JSON content in session file — file may be corrupted or encrypted with a different key",
      );
    }
  }

  /** Зашифровать JSONL-файл (по строке на объект). */
  encryptJSONL(lines: string[]): string[] {
    if (!this.config.enabled) return lines;
    return lines.map((line) => this.encryptFileContent(line));
  }

  /**
   * Расшифровать JSONL. Строка с ошибкой (битая, оборванная крашем, чужой
   * plaintext) логируется и ПРОПУСКАЕТСЯ — одна плохая строка не должна
   * убивать всю историю сессии.
   */
  decryptJSONL(lines: string[]): string[] {
    if (!this.config.enabled) return lines;
    return lines.flatMap((line) => {
      try {
        return [this.decryptFileContent(line)];
      } catch (e) {
        defaultOutputBus.log(
          "error",
          "security",
          `[session-encryption] failed to decrypt JSONL line — skipping it: ${
            e instanceof Error ? e.message : String(e)
          }`,
          { persist: true },
        );
        return [];
      }
    });
  }

  /** Прочитать и расшифровать файл сессии. */
  readSessionFile(filePath: string): string {
    const content = readFileSync(filePath, "utf8");
    return this.decryptFileContent(content);
  }

  /** Зашифровать и записать файл сессии. */
  writeSessionFile(filePath: string, content: string): void {
    const encrypted = this.encryptFileContent(content);
    writeFileSync(filePath, encrypted, "utf8");
  }

  /** Прочитать и расшифровать JSON-файл сессии. */
  readSessionJSON<T>(filePath: string): T {
    const content = readFileSync(filePath, "utf8");
    return this.decryptJSON<T>(content);
  }

  /** Зашифровать и записать JSON-файл сессии. */
  writeSessionJSON<T>(filePath: string, obj: T): void {
    const content = this.encryptJSON(obj);
    writeFileSync(filePath, content, "utf8");
  }

  /** Прочитать и расшифровать JSONL-файл сессии (битые строки пропускаются). */
  readSessionJSONL<T>(filePath: string): T[] {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((line) => line.trim());
    const decryptedLines = this.decryptJSONL(lines);
    // Кривые строки пропускаем, а не роняем весь лог сессии
    return decryptedLines.flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
  }

  /** Добавить зашифрованную запись в JSONL-файл. */
  appendToSessionJSONL<T>(filePath: string, obj: T): void {
    const encryptedLine = this.encryptFileContent(JSON.stringify(obj));
    writeFileSync(filePath, `${encryptedLine}\n`, {
      flag: "a",
      encoding: "utf8",
    });
  }

  /** Зашифровать все файлы каталога сессии (*.enc, оригиналы удаляются). */
  encryptSessionDirectory(sessionDir: string): void {
    if (!this.config.enabled) return;

    const files = readdirSync(sessionDir);
    for (const file of files) {
      const filePath = join(sessionDir, file);
      if (existsSync(filePath) && !file.endsWith(".enc")) {
        try {
          const content = readFileSync(filePath, "utf8");
          const encrypted = this.encryptFileContent(content);
          writeFileSync(`${filePath}.enc`, encrypted, "utf8");
          unlinkSync(filePath);
        } catch {
          // Бинарники и нечитаемое пропускаем
        }
      }
    }
  }

  /** Расшифровать все *.enc в каталоге сессии (оригиналы восстанавливаются). */
  decryptSessionDirectory(sessionDir: string): void {
    if (!this.config.enabled) return;

    const files = readdirSync(sessionDir);
    for (const file of files) {
      if (file.endsWith(".enc")) {
        const encFilePath = join(sessionDir, file);
        const decFilePath = encFilePath.slice(0, -4); // снять .enc
        try {
          const content = readFileSync(encFilePath, "utf8");
          const decrypted = this.decryptFileContent(content);
          writeFileSync(decFilePath, decrypted, "utf8");
          unlinkSync(encFilePath);
        } catch {
          // Нерасшифровываемое пропускаем
        }
      }
    }
  }
}

/** Глобальный шифровальщик файлов сессии. */
export const globalSessionEncryptor = new SessionFileEncryptor();

/** Создать шифровальщик файлов сессии с кастомным конфигом. */
export function createSessionFileEncryptor(
  config?: Partial<SessionEncryptionConfig>,
): SessionFileEncryptor {
  return new SessionFileEncryptor(config);
}

/** Хелпер: зашифровать объект сообщения (для SessionMessage). */
export function encryptSessionMessage(msg: any): string {
  return globalSessionEncryptor.encryptJSON(msg);
}

/** Хелпер: расшифровать сообщение сессии. */
export function decryptSessionMessage(encrypted: string): any {
  return globalSessionEncryptor.decryptJSON(encrypted);
}
