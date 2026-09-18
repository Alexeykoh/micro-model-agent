import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "fs";
import { join, dirname, basename } from "path";
import { homedir } from "os";
import {
  encryptString,
  decryptString,
  isEncryptedString,
  generateEncryptionKey,
  getOrCreateEncryptionKey,
  ConfigEncryptor,
} from "./encryption";
import { Logger } from "../../logger/app-logger";

const logger = new Logger("warn", "security");

/**
 * Session file encryption configuration
 */
export interface SessionEncryptionConfig {
  /**
   * Enable session file encryption
   */
  enabled: boolean;
  /**
   * Encrypt history.jsonl files
   */
  encryptHistory: boolean;
  /**
   * Encrypt session.jsonl files
   */
  encryptSessionLog: boolean;
  /**
   * Custom encryption key path (optional)
   */
  keyPath?: string;
}

/**
 * Default session encryption configuration
 */
export const DEFAULT_SESSION_ENCRYPTION: SessionEncryptionConfig = {
  enabled: false,
  encryptHistory: true,
  encryptSessionLog: true,
};

/**
 * Session file encryptor/decryptor
 */
export class SessionFileEncryptor {
  private config: SessionEncryptionConfig;
  private encryptor: ConfigEncryptor;

  constructor(config?: Partial<SessionEncryptionConfig>) {
    this.config = { ...DEFAULT_SESSION_ENCRYPTION, ...config };
    this.encryptor = new ConfigEncryptor({
      keyPath: config?.keyPath || join(homedir(), ".mma", ".session-encryption-key"),
    });
  }

  /**
   * Check if session file encryption is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Encrypt a session file content
   */
  encryptFileContent(content: string): string {
    if (!this.config.enabled) return content;
    return encryptString(content, this.encryptor.getKey());
  }

  /**
   * Decrypt a session file content
   */
  decryptFileContent(content: string): string {
    if (!this.config.enabled) return content;
    if (!isEncryptedString(content)) return content;
    return decryptString(content, this.encryptor.getKey());
  }

  /**
   * Encrypt a JSON object (for structured files)
   */
  encryptJSON<T>(obj: T): string {
    if (!this.config.enabled) return JSON.stringify(obj);
    return this.encryptFileContent(JSON.stringify(obj));
  }

  /**
   * Decrypt a JSON string
   */
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

  /**
   * Encrypt a JSONL file (one JSON object per line)
   */
  encryptJSONL(lines: string[]): string[] {
    if (!this.config.enabled) return lines;
    return lines.map((line) => this.encryptFileContent(line));
  }

  /**
   * Decrypt a JSONL file. A line that fails to decrypt (corrupted, truncated
   * by a crash, or foreign plaintext) is logged and SKIPPED — one bad line
   * must not make the whole session history unreadable.
   */
  decryptJSONL(lines: string[]): string[] {
    if (!this.config.enabled) return lines;
    return lines.flatMap((line) => {
      try {
        return [this.decryptFileContent(line)];
      } catch (e) {
        logger.logSilent(
          "error",
          `[session-encryption] failed to decrypt JSONL line — skipping it: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        return [];
      }
    });
  }

  /**
   * Read and decrypt a session file
   */
  readSessionFile(filePath: string): string {
    const content = readFileSync(filePath, "utf8");
    return this.decryptFileContent(content);
  }

  /**
   * Write and encrypt a session file
   */
  writeSessionFile(filePath: string, content: string): void {
    const encrypted = this.encryptFileContent(content);
    writeFileSync(filePath, encrypted, "utf8");
  }

  /**
   * Read and decrypt a JSON session file
   */
  readSessionJSON<T>(filePath: string): T {
    const content = readFileSync(filePath, "utf8");
    return this.decryptJSON<T>(content);
  }

  /**
   * Write and encrypt a JSON session file
   */
  writeSessionJSON<T>(filePath: string, obj: T): void {
    const content = this.encryptJSON(obj);
    writeFileSync(filePath, content, "utf8");
  }

  /**
   * Read and decrypt a JSONL session file
   */
  readSessionJSONL<T>(filePath: string): T[] {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((line) => line.trim());
    const decryptedLines = this.decryptJSONL(lines);
    // Skip malformed lines instead of crashing the whole session log
    return decryptedLines.flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
  }

  /**
   * Append an encrypted entry to a JSONL file
   */
  appendToSessionJSONL<T>(filePath: string, obj: T): void {
    const encryptedLine = this.encryptFileContent(JSON.stringify(obj));
    writeFileSync(filePath, encryptedLine + "\n", {
      flag: "a",
      encoding: "utf8",
    });
  }

  /**
   * Encrypt all session files in a directory
   */
  encryptSessionDirectory(sessionDir: string): void {
    if (!this.config.enabled) return;

    const files = readdirSync(sessionDir);
    for (const file of files) {
      const filePath = join(sessionDir, file);
      if (existsSync(filePath) && !file.endsWith(".enc")) {
        try {
          const content = readFileSync(filePath, "utf8");
          const encrypted = this.encryptFileContent(content);
          writeFileSync(filePath + ".enc", encrypted, "utf8");
          unlinkSync(filePath);
        } catch {
          // Skip binary files or files we can't read
        }
      }
    }
  }

  /**
   * Decrypt all session files in a directory
   */
  decryptSessionDirectory(sessionDir: string): void {
    if (!this.config.enabled) return;

    const files = readdirSync(sessionDir);
    for (const file of files) {
      if (file.endsWith(".enc")) {
        const encFilePath = join(sessionDir, file);
        const decFilePath = encFilePath.slice(0, -4); // Remove .enc
        try {
          const content = readFileSync(encFilePath, "utf8");
          const decrypted = this.decryptFileContent(content);
          writeFileSync(decFilePath, decrypted, "utf8");
          unlinkSync(encFilePath);
        } catch {
          // Skip files we can't decrypt
        }
      }
    }
  }
}

/**
 * Global session file encryptor instance
 */
export const globalSessionEncryptor = new SessionFileEncryptor();

/**
 * Create a session file encryptor with custom configuration
 */
export function createSessionFileEncryptor(
  config?: Partial<SessionEncryptionConfig>,
): SessionFileEncryptor {
  return new SessionFileEncryptor(config);
}

/**
 * Helper to encrypt a message object (for SessionMessage)
 */
export function encryptSessionMessage(msg: any): string {
  return globalSessionEncryptor.encryptJSON(msg);
}

/**
 * Helper to decrypt a session message
 */
export function decryptSessionMessage(encrypted: string): any {
  return globalSessionEncryptor.decryptJSON(encrypted);
}
