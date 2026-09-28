// Шифрование секретов конфига: AES-256-CBC + HMAC, ключ в ~/.mma/.encryption-key.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "fs";
import { globalMmaDir } from "../../config/paths";

/** Конфиг шифрования. */
export interface EncryptionConfig {
  /** Путь к файлу ключа. Дефолт: ~/.mma/.encryption-key */
  keyPath?: string;
  /** Алгоритм. Дефолт: aes-256-gcm */
  algorithm?: string;
}

const DEFAULT_CONFIG: Required<EncryptionConfig> = {
  keyPath: join(globalMmaDir(), ".encryption-key"),
  algorithm: "aes-256-gcm",
};

const IV_LENGTH = 16;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;

/** Сгенерировать новый ключ шифрования. */
export function generateEncryptionKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

/** Взять ключ из файла или создать новый. */
export function getOrCreateEncryptionKey(config?: EncryptionConfig): Buffer {
  const { keyPath } = { ...DEFAULT_CONFIG, ...config };

  // Каталог обязан существовать
  const dir = join(keyPath, "..");
  if (!existsSync(dir)) {
    // mkdirSync тут нельзя — чистая функция, создаёт вызывающий
  }

  if (!existsSync(keyPath)) {
    const key = generateEncryptionKey();
    try {
      writeFileSync(keyPath, key.toString("base64"), { mode: 0o600 });
      return key;
    } catch (e) {
      // Без персиста ключа зашифрованное станет невосстановимым при
      // следующем запуске — падаем громко, а не деградируем молча.
      throw new Error(
        `Cannot write encryption key to ${keyPath}: ${errMsg(e)}`,
      );
    }
  }

  try {
    const keyBase64 = readFileSync(keyPath, "utf8");
    return Buffer.from(keyBase64, "base64");
  } catch {
    // Битый ключ бэкапим перед выбросом
    try {
      const backupPath = `${keyPath}.corrupted.${Date.now()}`;
      copyFileSync(keyPath, backupPath);
    } catch {
      /* бэкап не удался, идём дальше */
    }
    throw new Error(
      `Encryption key file is corrupted or unreadable: ${keyPath}. ` +
        `All previously encrypted data will be unrecoverable. ` +
        `Delete the key file to generate a new one.`,
    );
  }
}

/**
 * Зашифровать строку (AES-256-GCM).
 * В crypto Bun нет getAuthTag/setAuthTag напрямую, поэтому проще:
 * AES-256-CBC + HMAC для аутентификации.
 */
export function encryptString(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const salt = randomBytes(SALT_LENGTH);

  // Ключ шифрования и HMAC-ключ выводятся из главного ключа
  const encKey = scryptSync(key, salt, KEY_LENGTH);
  const hmacSalt = Buffer.concat([salt, Buffer.from([1, 2, 3, 4])]);
  const hmacKey = scryptSync(key, hmacSalt, KEY_LENGTH);

  // Шифрование AES-256-CBC
  const cipher = createCipheriv("aes-256-cbc", encKey, iv);
  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");

  // HMAC для аутентификации
  const hmac = createHmac("sha256", hmacKey);
  hmac.update(iv);
  hmac.update(Buffer.from(encrypted, "base64"));
  const authTag = hmac.digest();

  // Формат: salt:iv:authTag:encrypted
  return `${salt.toString("base64")}:${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted}`;
}

/** Расшифровать строку (AES-256-CBC + HMAC). */
export function decryptString(encryptedText: string, key: Buffer): string {
  const parts = encryptedText.split(":");
  if (parts.length !== 4) {
    throw new Error("Invalid encrypted format");
  }

  const salt = Buffer.from(parts[0], "base64");
  const iv = Buffer.from(parts[1], "base64");
  const authTag = Buffer.from(parts[2], "base64");
  const encrypted = parts[3];

  // Ключ шифрования и HMAC-ключ выводятся из главного ключа
  const encKey = scryptSync(key, salt, KEY_LENGTH);
  const hmacSalt = Buffer.concat([salt, Buffer.from([1, 2, 3, 4])]);
  const hmacKey = scryptSync(key, hmacSalt, KEY_LENGTH);

  // Проверка HMAC
  const hmac = createHmac("sha256", hmacKey);
  hmac.update(iv);
  hmac.update(Buffer.from(encrypted, "base64"));
  const computedTag = hmac.digest();

  if (computedTag.length !== authTag.length || !timingSafeEqual(computedTag, authTag)) {
    throw new Error("Authentication failed: invalid tag");
  }

  // Расшифровка AES-256-CBC
  const decipher = createDecipheriv("aes-256-cbc", encKey, iv);
  let decrypted = decipher.update(encrypted, "base64", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

import { createHmac } from "node:crypto";
import { errMsg } from "../../utils";

/** Похоже ли значение на зашифрованное (формат salt:iv:authTag:encrypted). */
export function isEncryptedString(value: string): boolean {
  // Формат: salt:iv:authTag:encrypted, каждая часть — base64 через двоеточие
  const parts = value.split(":");
  if (parts.length !== 4) return false;

  // Строгая проверка формы base64: Buffer.from(value, "base64") НИКОГДА не бросает
  // (ленивое декодирование), так что plaintext от base64 он не отличит.
  const isB64 = (s: string) =>
    s.length > 0 && s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
  return parts.every(isB64);
}

/** Имена чувствительных полей для шифрования. */
export const SENSITIVE_FIELD_NAMES = [
  "api_key",
  "apikey",
  "apiKey",
  "token",
  "access_token",
  "accessToken",
  "password",
  "passwd",
  "pwd",
  "secret",
  "private_key",
  "privateKey",
  "auth",
  "authorization",
  "key",
];

/** Имя поля указывает на чувствительные данные или нет. */
export function isSensitiveFieldName(fieldName: string): boolean {
  const lowerFieldName = fieldName.toLowerCase();
  return SENSITIVE_FIELD_NAMES.some((name) => lowerFieldName.includes(name));
}

/** Зашифровать чувствительные поля объекта (рекурсивно, RegExp не трогает). */
export function encryptSensitiveFields<T extends Record<string, unknown>>(obj: T, key: Buffer): T {
  const result: Record<string, unknown> = {};

  for (const [fieldName, value] of Object.entries(obj)) {
    if (isSensitiveFieldName(fieldName) && typeof value === "string" && !isEncryptedString(value)) {
      result[fieldName] = encryptString(value, key);
    } else if (typeof value === "object" && value !== null) {
      if (Array.isArray(value)) {
        result[fieldName] = value.map((item) =>
          typeof item === "object" && item !== null && !(item instanceof RegExp)
            ? encryptSensitiveFields(item as Record<string, unknown>, key)
            : item,
        );
      } else if (value instanceof RegExp) {
        result[fieldName] = value;
      } else {
        result[fieldName] = encryptSensitiveFields(value as Record<string, unknown>, key);
      }
    } else {
      result[fieldName] = value;
    }
  }

  return result as T;
}

/** Расшифровать чувствительные поля объекта; неудача — оставить как есть. */
export function decryptSensitiveFields<T extends Record<string, unknown>>(obj: T, key: Buffer): T {
  const result: Record<string, unknown> = {};

  for (const [fieldName, value] of Object.entries(obj)) {
    if (isSensitiveFieldName(fieldName) && typeof value === "string" && isEncryptedString(value)) {
      try {
        result[fieldName] = decryptString(value, key);
      } catch {
        // Расшифровка не удалась — оставить зашифрованное значение
        result[fieldName] = value;
      }
    } else if (typeof value === "object" && value !== null) {
      if (Array.isArray(value)) {
        result[fieldName] = value.map((item) =>
          typeof item === "object" && item !== null && !(item instanceof RegExp)
            ? decryptSensitiveFields(item as Record<string, unknown>, key)
            : item,
        );
      } else if (value instanceof RegExp) {
        result[fieldName] = value;
      } else {
        result[fieldName] = decryptSensitiveFields(value as Record<string, unknown>, key);
      }
    } else {
      result[fieldName] = value;
    }
  }

  return result as T;
}

/** Обёртка шифрования/расшифровки значений конфига. */
export class ConfigEncryptor {
  private key: Buffer;

  constructor(config?: EncryptionConfig) {
    this.key = getOrCreateEncryptionKey(config);
  }

  encrypt<T extends Record<string, unknown>>(config: T): T {
    return encryptSensitiveFields(config, this.key);
  }

  decrypt<T extends Record<string, unknown>>(config: T): T {
    return decryptSensitiveFields(config, this.key);
  }

  getKey(): Buffer {
    return this.key;
  }
}
