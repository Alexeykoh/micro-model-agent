import {
  encryptString,
  decryptString,
  isEncryptedString,
  isSensitiveFieldName,
  encryptSensitiveFields,
  decryptSensitiveFields,
  ConfigEncryptor,
  SENSITIVE_FIELD_NAMES,
} from '../../src/modules/security/encryption';
import { describe, it, expect } from 'vitest';

describe('Encryption', () => {
  const testKey = Buffer.from('test-key-32-bytes-long-1234567890', 'utf8');

  describe('encryptString / decryptString', () => {
    it('should encrypt and decrypt a string', () => {
      const plaintext = 'my secret password';
      const encrypted = encryptString(plaintext, testKey);
      const decrypted = decryptString(encrypted, testKey);
      expect(decrypted).toBe(plaintext);
    });

    it('should produce different encrypted strings for the same input', () => {
      const plaintext = 'test';
      const encrypted1 = encryptString(plaintext, testKey);
      const encrypted2 = encryptString(plaintext, testKey);
      expect(encrypted1).not.toBe(encrypted2);
    });

    it('should throw error for invalid encrypted format', () => {
      expect(() => decryptString('invalid-format', testKey)).toThrow('Invalid encrypted format');
    });

    it('should throw error for tampered encrypted string', () => {
      const plaintext = 'test';
      const encrypted = encryptString(plaintext, testKey);
      // Tamper with the encrypted string
      const tampered = encrypted.replace(/a/gi, 'b');
      expect(() => decryptString(tampered, testKey)).toThrow('Authentication failed');
    });

    it('should throw error for wrong key', () => {
      const plaintext = 'test';
      const encrypted = encryptString(plaintext, testKey);
      const wrongKey = Buffer.from('wrong-key-32-bytes-long-1234567890', 'utf8');
      expect(() => decryptString(encrypted, wrongKey)).toThrow('Authentication failed');
    });
  });

  describe('isEncryptedString', () => {
    it('should detect encrypted strings', () => {
      const encrypted = encryptString('test', testKey);
      expect(isEncryptedString(encrypted)).toBe(true);
    });

    it('should not detect non-encrypted strings', () => {
      expect(isEncryptedString('plain text')).toBe(false);
      expect(isEncryptedString('base64:data')).toBe(false);
      expect(isEncryptedString('a:b:c')).toBe(false);
    });

    it('should not detect partially encrypted strings', () => {
      expect(isEncryptedString('a:b')).toBe(false);
      expect(isEncryptedString('a:b:c:d:e')).toBe(false);
    });
  });

  describe('isSensitiveFieldName', () => {
    it('should detect sensitive field names', () => {
      expect(isSensitiveFieldName('api_key')).toBe(true);
      expect(isSensitiveFieldName('API_KEY')).toBe(true);
      expect(isSensitiveFieldName('accessToken')).toBe(true);
      expect(isSensitiveFieldName('my_password')).toBe(true);
      expect(isSensitiveFieldName('user_secret')).toBe(true);
    });

    it('should not detect non-sensitive field names', () => {
      expect(isSensitiveFieldName('model')).toBe(false);
      expect(isSensitiveFieldName('baseUrl')).toBe(false);
      expect(isSensitiveFieldName('name')).toBe(false);
    });
  });

  describe('encryptSensitiveFields / decryptSensitiveFields', () => {
    it('should encrypt sensitive fields', () => {
      const config = {
        model: 'qwen3.5-9b',
        api_key: 'secret-key-123',
        baseUrl: 'http://localhost:1234',
        token: 'secret-token-456',
      };
      
      const encrypted = encryptSensitiveFields(config, testKey);
      expect(encrypted.api_key).not.toBe('secret-key-123');
      expect(encrypted.token).not.toBe('secret-token-456');
      expect(encrypted.model).toBe('qwen3.5-9b');
      expect(encrypted.baseUrl).toBe('http://localhost:1234');
    });

    it('should decrypt sensitive fields', () => {
      const config = {
        model: 'qwen3.5-9b',
        api_key: 'secret-key-123',
        baseUrl: 'http://localhost:1234',
        token: 'secret-token-456',
      };
      
      const encrypted = encryptSensitiveFields(config, testKey);
      const decrypted = decryptSensitiveFields(encrypted, testKey);
      expect(decrypted.api_key).toBe('secret-key-123');
      expect(decrypted.token).toBe('secret-token-456');
      expect(decrypted.model).toBe('qwen3.5-9b');
      expect(decrypted.baseUrl).toBe('http://localhost:1234');
    });

    it('should handle nested objects', () => {
      const config = {
        provider: {
          type: 'openai-compat',
          apiKey: 'secret-api-key',
        },
        model: 'qwen3.5-9b',
      };
      
      const encrypted = encryptSensitiveFields(config, testKey);
      const decrypted = decryptSensitiveFields(encrypted, testKey);
      expect((decrypted.provider as any).apiKey).toBe('secret-api-key');
    });

    it('should not encrypt already encrypted fields', () => {
      const alreadyEncrypted = encryptString('secret', testKey);
      const config = {
        api_key: alreadyEncrypted,
      };
      
      const encrypted = encryptSensitiveFields(config, testKey);
      expect(encrypted.api_key).toBe(alreadyEncrypted);
    });

    it('should handle non-string sensitive fields', () => {
      const config = {
        api_key: 12345, // Not a string
        token: null,
      };
      
      const encrypted = encryptSensitiveFields(config, testKey);
      expect(encrypted.api_key).toBe(12345);
      expect(encrypted.token).toBe(null);
    });
  });

  describe('ConfigEncryptor', () => {
    it('should encrypt and decrypt config', () => {
      const encryptor = new ConfigEncryptor();
      const config = {
        model: 'qwen3.5-9b',
        api_key: 'secret-key',
        provider: {
          apiKey: 'provider-key',
        },
      };
      
      const encrypted = encryptor.encrypt(config);
      const decrypted = encryptor.decrypt(encrypted);
      
      expect(decrypted.model).toBe('qwen3.5-9b');
      expect(decrypted.api_key).toBe('secret-key');
      expect((decrypted.provider as any).apiKey).toBe('provider-key');
    });

    it('should return the encryption key', () => {
      const encryptor = new ConfigEncryptor();
      expect(encryptor.getKey()).toBeInstanceOf(Buffer);
      expect(encryptor.getKey().length).toBeGreaterThan(0);
    });
  });

  describe('SENSITIVE_FIELD_NAMES', () => {
    it('should contain common sensitive field names', () => {
      expect(SENSITIVE_FIELD_NAMES).toContain('api_key');
      expect(SENSITIVE_FIELD_NAMES).toContain('token');
      expect(SENSITIVE_FIELD_NAMES).toContain('password');
      expect(SENSITIVE_FIELD_NAMES).toContain('secret');
    });
  });
});
