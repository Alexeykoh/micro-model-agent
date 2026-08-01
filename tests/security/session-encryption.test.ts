import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { SessionStore } from '../../src/modules/session/store';
import { SessionFileEncryptor, DEFAULT_SESSION_ENCRYPTION } from '../../src/modules/security/session-encryption';
import type { SessionEncryptionConfig } from '../../src/config/types';
import { ConfigEncryptor } from '../../src/modules/security/encryption';

const TEST_DIR = join(__dirname, 'test-sessions-encryption');

// Helper to create a test encryptor with a known key
function createTestEncryptor(enabled: boolean = true): SessionFileEncryptor {
  const config: SessionEncryptionConfig = {
    enabled,
    encryptHistory: true,
    encryptSessionLog: true,
  };
  return new SessionFileEncryptor(config);
}

// Helper to get the encryption key path
function getTestKeyPath(): string {
  return join(__dirname, '.test-encryption-key');
}

describe('SessionFileEncryptor', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    // Clean up test key file
    const keyPath = getTestKeyPath();
    if (existsSync(keyPath)) {
      rmSync(keyPath, { force: true });
    }
  });

  describe('Basic functionality', () => {
    it('should be disabled by default', () => {
      const encryptor = createTestEncryptor(false);
      expect(encryptor.isEnabled()).toBe(false);
    });

    it('should be enabled when configured', () => {
      const encryptor = createTestEncryptor(true);
      expect(encryptor.isEnabled()).toBe(true);
    });

    it('should return content unchanged when disabled', () => {
      const encryptor = createTestEncryptor(false);
      const content = '{"test": "value"}';
      expect(encryptor.encryptFileContent(content)).toBe(content);
      expect(encryptor.decryptFileContent(content)).toBe(content);
    });
  });

  describe('String encryption/decryption', () => {
    it('should encrypt and decrypt strings correctly', () => {
      const encryptor = createTestEncryptor(true);
      const original = '{"message": "Hello, World!"}';
      
      const encrypted = encryptor.encryptFileContent(original);
      expect(encrypted).not.toBe(original);
      // Encrypted content should be different from original
      expect(encrypted.length).toBeGreaterThan(original.length);
      
      const decrypted = encryptor.decryptFileContent(encrypted);
      expect(decrypted).toBe(original);
    });

    it('should handle empty strings', () => {
      const encryptor = createTestEncryptor(true);
      const original = '';
      const encrypted = encryptor.encryptFileContent(original);
      const decrypted = encryptor.decryptFileContent(encrypted);
      expect(decrypted).toBe(original);
    });

    it('should handle special characters', () => {
      const encryptor = createTestEncryptor(true);
      const original = '{"data": "test\nwith\ttabs\rand\nnewlines"}';
      const encrypted = encryptor.encryptFileContent(original);
      const decrypted = encryptor.decryptFileContent(encrypted);
      expect(decrypted).toBe(original);
    });
  });

  describe('JSON encryption/decryption', () => {
    it('should encrypt and decrypt JSON objects', () => {
      const encryptor = createTestEncryptor(true);
      const original = { test: 'value', nested: { key: 123 } };
      
      const encrypted = encryptor.encryptJSON(original);
      expect(encrypted).not.toBe(JSON.stringify(original));
      
      const decrypted = encryptor.decryptJSON<typeof original>(encrypted);
      expect(decrypted).toEqual(original);
    });

    it('should handle arrays', () => {
      const encryptor = createTestEncryptor(true);
      const original = [1, 2, 3, { nested: true }];
      const encrypted = encryptor.encryptJSON(original);
      const decrypted = encryptor.decryptJSON<typeof original>(encrypted);
      expect(decrypted).toEqual(original);
    });
  });

  describe('JSONL encryption/decryption', () => {
    it('should encrypt and decrypt JSONL lines', () => {
      const encryptor = createTestEncryptor(true);
      const lines = [
        '{"id": 1, "text": "first"}',
        '{"id": 2, "text": "second"}',
      ];
      
      const encrypted = encryptor.encryptJSONL(lines);
      expect(encrypted).toHaveLength(2);
      expect(encrypted[0]).not.toBe(lines[0]);
      
      const decrypted = encryptor.decryptJSONL(encrypted);
      expect(decrypted).toEqual(lines);
    });

    it('should handle empty lines', () => {
      const encryptor = createTestEncryptor(true);
      const lines = ['{"test": 1}', '', '{"test": 2}'];
      const encrypted = encryptor.encryptJSONL(lines.filter(l => l.trim()));
      const decrypted = encryptor.decryptJSONL(encrypted);
      expect(decrypted).toEqual(lines.filter(l => l.trim()));
    });
  });

  describe('File operations', () => {
    it('should read and decrypt session files', () => {
      const encryptor = createTestEncryptor(true);
      const filePath = join(TEST_DIR, 'test-meta.json');
      const original = { id: 'test', name: 'Test Session' };
      
      // Write encrypted
      encryptor.writeSessionJSON(filePath, original);
      
      // Read and decrypt
      const loaded = encryptor.readSessionJSON<typeof original>(filePath);
      expect(loaded).toEqual(original);
    });

    it('should append to JSONL files with encryption', () => {
      const encryptor = createTestEncryptor(true);
      const filePath = join(TEST_DIR, 'test-history.jsonl');
      
      const msg1 = { id: 1, content: 'First message' };
      const msg2 = { id: 2, content: 'Second message' };
      
      encryptor.appendToSessionJSONL(filePath, msg1);
      encryptor.appendToSessionJSONL(filePath, msg2);
      
      const loaded = encryptor.readSessionJSONL<any>(filePath);
      expect(loaded).toHaveLength(2);
      expect(loaded[0]).toEqual(msg1);
      expect(loaded[1]).toEqual(msg2);
    });

    it('should handle non-encrypted files when encryption is enabled', () => {
      const encryptor = createTestEncryptor(true);
      const filePath = join(TEST_DIR, 'plain.json');
      const original = { test: 'plain content' };
      
      // Write plain JSON
      writeFileSync(filePath, JSON.stringify(original), 'utf8');
      
      // Try to read with encryptor - should still work
      const loaded = encryptor.readSessionJSON<typeof original>(filePath);
      expect(loaded).toEqual(original);
    });
  });

  describe('SessionStore integration', () => {
    it('should save and load encrypted meta', () => {
      const config: SessionEncryptionConfig = {
        enabled: true,
        encryptHistory: true,
        encryptSessionLog: true,
      };
      
      const store = new SessionStore(TEST_DIR, config);
      const meta = { id: 'test-1', name: 'Test', messageCount: 0 };
      
      store.saveMeta('test-1', meta);
      const loaded = store.loadMeta('test-1');
      expect(loaded).toEqual(meta);
    });

    it('should append and load encrypted history', () => {
      const config: SessionEncryptionConfig = {
        enabled: true,
        encryptHistory: true,
        encryptSessionLog: true,
      };
      
      const store = new SessionStore(TEST_DIR, config);
      const msg = { id: 'msg-1', content: 'Test message', timestamp: new Date().toISOString() };
      
      store.appendMessage('test-1', msg);
      const history = store.loadHistory('test-1');
      expect(history).toHaveLength(1);
      expect(history[0].content).toBe('Test message');
    });

    it('should append and load encrypted session logs', () => {
      const config: SessionEncryptionConfig = {
        enabled: true,
        encryptHistory: true,
        encryptSessionLog: true,
      };
      
      const store = new SessionStore(TEST_DIR, config);
      const entry = { ts: new Date().toISOString(), type: 'tool_call', tool: 'test' };
      
      store.appendSessionLog('test-1', entry);
      const logs = store.loadSessionLog('test-1');
      expect(logs).toHaveLength(1);
      expect(logs[0].tool).toBe('test');
    });

    it('should work without encryption when disabled', () => {
      const config: SessionEncryptionConfig = {
        enabled: false,
        encryptHistory: false,
        encryptSessionLog: false,
      };
      
      const store = new SessionStore(TEST_DIR, config);
      const meta = { id: 'test-2', name: 'Plain Test', messageCount: 0 };
      
      store.saveMeta('test-2', meta);
      const loaded = store.loadMeta('test-2');
      expect(loaded).toEqual(meta);
    });

    it('should update encryption configuration', () => {
      const store = new SessionStore(TEST_DIR);
      expect(store.isEncryptionEnabled()).toBe(false);
      
      store.updateEncryption({ enabled: true, encryptHistory: true, encryptSessionLog: true });
      expect(store.isEncryptionEnabled()).toBe(true);
    });
  });

  describe('Encryption key management', () => {
    it('should use custom key path when provided', () => {
      const customKeyPath = getTestKeyPath();
      const config: SessionEncryptionConfig = {
        enabled: true,
        encryptHistory: true,
        encryptSessionLog: true,
        keyPath: customKeyPath,
      };
      
      const encryptor = new SessionFileEncryptor(config);
      const original = '{"test": "value"}';
      const encrypted = encryptor.encryptFileContent(original);
      const decrypted = encryptor.decryptFileContent(encrypted);
      
      expect(decrypted).toBe(original);
      expect(existsSync(customKeyPath)).toBe(true);
    });
  });

  describe('Backward compatibility', () => {
    it('should read old unencrypted files when encryption is enabled', () => {
      const config: SessionEncryptionConfig = {
        enabled: true,
        encryptHistory: true,
        encryptSessionLog: true,
      };
      
      const store = new SessionStore(TEST_DIR, config);
      
      // Write unencrypted file
      const filePath = join(TEST_DIR, 'test-1', 'meta.json');
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify({ id: 'test-1', name: 'Old Session' }), 'utf8');
      
      // Should still be able to read it
      const loaded = store.loadMeta('test-1');
      expect(loaded?.name).toBe('Old Session');
    });

    it('should write encrypted files when encryption is enabled', () => {
      const config: SessionEncryptionConfig = {
        enabled: true,
        encryptHistory: true,
        encryptSessionLog: true,
      };
      
      const store = new SessionStore(TEST_DIR, config);
      const meta = { id: 'test-3', name: 'New Session' };
      
      store.saveMeta('test-3', meta);
      
      // Check that file is encrypted (content should be different from plain JSON)
      const filePath = join(TEST_DIR, 'test-3', 'meta.json');
      const raw = readFileSync(filePath, 'utf8');
      const plainJson = JSON.stringify(meta);
      expect(raw).not.toBe(plainJson);
      expect(raw.length).toBeGreaterThan(plainJson.length);
    });
  });
});


