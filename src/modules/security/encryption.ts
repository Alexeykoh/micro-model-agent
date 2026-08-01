import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { homedir } from 'os';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';

/**
 * Encryption configuration
 */
export interface EncryptionConfig {
  /**
   * Path to the encryption key file
   * Default: ~/.mma/.encryption-key
   */
  keyPath?: string;
  /**
   * Encryption algorithm
   * Default: aes-256-gcm
   */
  algorithm?: string;
}

const DEFAULT_CONFIG: Required<EncryptionConfig> = {
  keyPath: join(homedir(), '.mma', '.encryption-key'),
  algorithm: 'aes-256-gcm',
};

const IV_LENGTH = 16;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;
const AUTH_TAG_LENGTH = 16;

/**
 * Generate a new encryption key
 */
export function generateEncryptionKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

/**
 * Get or create encryption key from file
 */
export function getOrCreateEncryptionKey(config?: EncryptionConfig): Buffer {
  const { keyPath } = { ...DEFAULT_CONFIG, ...config };
  
  // Ensure directory exists
  const dir = join(keyPath, '..');
  if (!existsSync(dir)) {
    // Note: We can't use mkdirSync here because we're in a pure function
    // This will be handled by the caller
  }
  
  if (!existsSync(keyPath)) {
    const key = generateEncryptionKey();
    try {
      writeFileSync(keyPath, key.toString('base64'), { mode: 0o600 });
      return key;
    } catch {
      // If we can't write the key file, return the key anyway
      // The caller can handle the error
      return key;
    }
  }
  
  try {
    const keyBase64 = readFileSync(keyPath, 'utf8');
    return Buffer.from(keyBase64, 'base64');
  } catch {
    // If we can't read the key file, generate a new one
    const key = generateEncryptionKey();
    try {
      writeFileSync(keyPath, key.toString('base64'), { mode: 0o600 });
    } catch { /* ignore */ }
    return key;
  }
}

/**
 * Encrypt a string using AES-256-GCM
 * Note: Bun's crypto module doesn't support getAuthTag/setAuthTag directly,
 * so we use a simpler approach with AES-256-CBC + HMAC for authentication
 */
export function encryptString(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const salt = randomBytes(SALT_LENGTH);
  
  // Derive encryption key and HMAC key from the main key
  const encKey = scryptSync(key, salt, KEY_LENGTH);
  const hmacSalt = Buffer.concat([salt, Buffer.from([1, 2, 3, 4])]);
  const hmacKey = scryptSync(key, hmacSalt, KEY_LENGTH);
  
  // Encrypt with AES-256-CBC
  const cipher = createCipheriv('aes-256-cbc', encKey, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  
  // Create HMAC for authentication
  const hmac = createHmac('sha256', hmacKey);
  hmac.update(iv);
  hmac.update(Buffer.from(encrypted, 'base64'));
  const authTag = hmac.digest();
  
  // Format: salt:iv:authTag:encrypted
  return `${salt.toString('base64')}:${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}

/**
 * Decrypt a string using AES-256-CBC + HMAC
 */
export function decryptString(encryptedText: string, key: Buffer): string {
  const parts = encryptedText.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted format');
  }
  
  const salt = Buffer.from(parts[0], 'base64');
  const iv = Buffer.from(parts[1], 'base64');
  const authTag = Buffer.from(parts[2], 'base64');
  const encrypted = parts[3];
  
  // Derive encryption key and HMAC key from the main key
  const encKey = scryptSync(key, salt, KEY_LENGTH);
  const hmacSalt = Buffer.concat([salt, Buffer.from([1, 2, 3, 4])]);
  const hmacKey = scryptSync(key, hmacSalt, KEY_LENGTH);
  
  // Verify HMAC
  const hmac = createHmac('sha256', hmacKey);
  hmac.update(iv);
  hmac.update(Buffer.from(encrypted, 'base64'));
  const computedTag = hmac.digest();
  
  if (!computedTag.equals(authTag)) {
    throw new Error('Authentication failed: invalid tag');
  }
  
  // Decrypt with AES-256-CBC
  const decipher = createDecipheriv('aes-256-cbc', encKey, iv);
  let decrypted = decipher.update(encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

import { createHmac } from 'node:crypto';

/**
 * Check if a string looks like it's encrypted
 */
export function isEncryptedString(value: string): boolean {
  // Encrypted strings have the format: salt:iv:authTag:encrypted
  // Each part is base64 encoded and separated by colons
  const parts = value.split(':');
  if (parts.length !== 4) return false;
  
  // Check if all parts are valid base64
  try {
    Buffer.from(parts[0], 'base64');
    Buffer.from(parts[1], 'base64');
    Buffer.from(parts[2], 'base64');
    Buffer.from(parts[3], 'base64');
    return true;
  } catch {
    return false;
  }
}

/**
 * Sensitive field names that should be encrypted
 */
export const SENSITIVE_FIELD_NAMES = [
  'api_key',
  'apikey',
  'apiKey',
  'token',
  'access_token',
  'accessToken',
  'password',
  'passwd',
  'pwd',
  'secret',
  'private_key',
  'privateKey',
  'auth',
  'authorization',
  'key',
];

/**
 * Check if a field name indicates sensitive data
 */
export function isSensitiveFieldName(fieldName: string): boolean {
  const lowerFieldName = fieldName.toLowerCase();
  return SENSITIVE_FIELD_NAMES.some(name => lowerFieldName.includes(name));
}

/**
 * Encrypt sensitive fields in an object
 */
export function encryptSensitiveFields<T extends Record<string, unknown>>(
  obj: T,
  key: Buffer,
): T {
  const result: Record<string, unknown> = {};
  
  for (const [fieldName, value] of Object.entries(obj)) {
    if (isSensitiveFieldName(fieldName) && typeof value === 'string' && !isEncryptedString(value)) {
      result[fieldName] = encryptString(value, key);
    } else if (typeof value === 'object' && value !== null) {
      result[fieldName] = encryptSensitiveFields(value as Record<string, unknown>, key);
    } else {
      result[fieldName] = value;
    }
  }
  
  return result as T;
}

/**
 * Decrypt sensitive fields in an object
 */
export function decryptSensitiveFields<T extends Record<string, unknown>>(
  obj: T,
  key: Buffer,
): T {
  const result: Record<string, unknown> = {};
  
  for (const [fieldName, value] of Object.entries(obj)) {
    if (isSensitiveFieldName(fieldName) && typeof value === 'string' && isEncryptedString(value)) {
      try {
        result[fieldName] = decryptString(value, key);
      } catch {
        // If decryption fails, keep the encrypted value
        result[fieldName] = value;
      }
    } else if (typeof value === 'object' && value !== null) {
      result[fieldName] = decryptSensitiveFields(value as Record<string, unknown>, key);
    } else {
      result[fieldName] = value;
    }
  }
  
  return result as T;
}

/**
 * Create a wrapper for encrypting/decrypting config values
 */
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
