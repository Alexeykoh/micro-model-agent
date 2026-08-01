import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { AuditNotifier, DEFAULT_AUDIT_NOTIFIER_CONFIG, type AuditNotification, type AuditNotifierConfig } from '../../src/modules/security/audit-notifier';
import type { AuditLogEntry } from '../../src/modules/security/audit-log';

const TEST_DIR = join(__dirname, 'test-audit-notifier');
const TEST_FILE = join(TEST_DIR, 'audit-notifications.jsonl');

describe('AuditNotifier', () => {
  let notifier: AuditNotifier;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('Configuration', () => {
    it('should be disabled by default', () => {
      notifier = new AuditNotifier();
      expect(notifier.isEnabled()).toBe(false);
    });

    it('should be enabled when configured', () => {
      const config: Partial<AuditNotifierConfig> = { enabled: true };
      notifier = new AuditNotifier(config);
      expect(notifier.isEnabled()).toBe(true);
    });

    it('should enable/disable dynamically', () => {
      notifier = new AuditNotifier();
      expect(notifier.isEnabled()).toBe(false);
      notifier.enable();
      expect(notifier.isEnabled()).toBe(true);
      notifier.disable();
      expect(notifier.isEnabled()).toBe(false);
    });

    it('should update configuration', () => {
      notifier = new AuditNotifier({ enabled: true });
      notifier.updateConfig({ minSeverity: 'high' });
      const config = (notifier as any).config;
      expect(config.minSeverity).toBe('high');
    });

    it('should use default file path', () => {
      notifier = new AuditNotifier();
      const config = (notifier as any).config;
      expect(config.filePath).toContain('.mma');
      expect(config.filePath).toContain('audit-notifications.jsonl');
    });

    it('should use custom file path', () => {
      notifier = new AuditNotifier({ filePath: TEST_FILE });
      const config = (notifier as any).config;
      expect(config.filePath).toBe(TEST_FILE);
    });
  });

  describe('Event filtering', () => {
    beforeEach(() => {
      notifier = new AuditNotifier({
        enabled: true,
        filePath: TEST_FILE,
        eventTypes: ['security_block', 'bash_command'],
        minSeverity: 'medium',
      });
    });

    it('should notify for configured event types', () => {
      expect(notifier.shouldNotify('security_block' as any)).toBe(true);
    });

    it('should not notify for unconfigured event types', () => {
      expect(notifier.shouldNotify('file_operation' as any)).toBe(false);
    });

    it('should notify for severity above minimum', () => {
      expect(notifier.shouldNotifySeverity('high')).toBe(true);
      expect(notifier.shouldNotifySeverity('critical')).toBe(true);
      expect(notifier.shouldNotifySeverity('medium')).toBe(true);
      expect(notifier.shouldNotifySeverity('low')).toBe(false);
    });

    it('should determine severity from event action', () => {
      const entry: AuditLogEntry = {
        timestamp: new Date().toISOString(),
        action: 'security_block',
        message: 'Test',
      };
      const severity = (notifier as any).determineSeverity(entry);
      expect(severity).toBe('high');
    });

    it('should map event actions correctly', () => {
      const mapper = (notifier as any).mapEventType;
      expect(mapper('security_block')).toBe('security_block');
      expect(mapper('bash_command')).toBe('bash_command');
      expect(mapper('file_write')).toBe('file_operation');
      expect(mapper('unknown')).toBeNull();
    });
  });

  describe('Notification sending', () => {
    beforeEach(() => {
      notifier = new AuditNotifier({
        enabled: true,
        filePath: TEST_FILE,
        eventTypes: ['security_block', 'bash_command', 'file_operation'],
        minSeverity: 'low',
      });
    });

    it('should return null when disabled', async () => {
      notifier.disable();
      const entry: AuditLogEntry = {
        timestamp: new Date().toISOString(),
        type: 'security_block',
        message: 'Test',
        severity: 'high',
      };
      const result = await notifier.notify(entry);
      expect(result).toBeNull();
    });

    it('should return null for unconfigured event types', async () => {
      const entry: AuditLogEntry = {
        timestamp: new Date().toISOString(),
        type: 'network_request',
        message: 'Test',
        severity: 'high',
      };
      const result = await notifier.notify(entry);
      expect(result).toBeNull();
    });

    it('should return null for low severity when min is medium', async () => {
      notifier.updateConfig({ minSeverity: 'medium' });
      const entry: AuditLogEntry = {
        timestamp: new Date().toISOString(),
        type: 'security_block',
        message: 'Test',
        severity: 'low',
      };
      const result = await notifier.notify(entry);
      expect(result).toBeNull();
    });

    it('should write to file when configured', async () => {
      const entry: AuditLogEntry = {
        timestamp: new Date().toISOString(),
        action: 'security_block',
        message: 'Blocked command',
        details: 'Blocked command',
      };
      await notifier.notify(entry);
      
      expect(existsSync(TEST_FILE)).toBe(true);
      const content = readFileSync(TEST_FILE, 'utf8');
      expect(content).toContain('security_block');
      expect(content).toContain('Blocked command');
    });

    it('should return notification object on success', async () => {
      const entry: AuditLogEntry = {
        timestamp: new Date().toISOString(),
        action: 'security_block',
        message: 'Blocked command',
        details: 'Blocked command',
        sessionId: 'ses-123',
      };
      const result = await notifier.notify(entry);
      
      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('security_block');
      expect(result?.severity).toBe('high');
      expect(result?.message).toBe('Blocked command');
      expect(result?.sessionId).toBe('ses-123');
    });
  });

  describe('File operations', () => {
    beforeEach(() => {
      notifier = new AuditNotifier({
        enabled: true,
        filePath: TEST_FILE,
        eventTypes: ['security_block'],
        minSeverity: 'low',
      });
    });

    it('should read notifications from file', async () => {
      const entry: AuditLogEntry = {
        timestamp: new Date().toISOString(),
        action: 'security_block',
        message: 'Test 1',
        details: 'Test 1',
      };
      await notifier.notify(entry);
      
      const notifications = notifier.readNotifications();
      expect(notifications).toHaveLength(1);
      expect(notifications[0].message).toBe('Test 1');
    });

    it('should read limited number of notifications', async () => {
      for (let i = 0; i < 5; i++) {
        const entry: AuditLogEntry = {
          timestamp: new Date().toISOString(),
          action: 'security_block',
          message: `Test ${i}`,
          details: `Test ${i}`,
        };
        await notifier.notify(entry);
      }
      
      const notifications = notifier.readNotifications(3);
      expect(notifications).toHaveLength(3);
    });

    it('should clear notifications', async () => {
      const entry: AuditLogEntry = {
        timestamp: new Date().toISOString(),
        type: 'security_block',
        message: 'Test',
        severity: 'high',
      };
      await notifier.notify(entry);
      
      notifier.clearNotifications();
      
      const notifications = notifier.readNotifications();
      expect(notifications).toHaveLength(0);
    });

    it('should return empty array for non-existent file', () => {
      const notifications = notifier.readNotifications();
      expect(notifications).toEqual([]);
    });
  });

  describe('Statistics', () => {
    beforeEach(() => {
      notifier = new AuditNotifier({
        enabled: true,
        filePath: TEST_FILE,
        eventTypes: ['security_block', 'bash_command', 'file_operation'],
        minSeverity: 'low',
      });
    });

    it('should return correct statistics', async () => {
      // Use actions that map to our configured event types
      const entries: AuditLogEntry[] = [
        { timestamp: new Date().toISOString(), action: 'security_block', message: 'Block 1', details: 'Block 1' },
        { timestamp: new Date().toISOString(), action: 'security_block', message: 'Block 2', details: 'Block 2' },
        { timestamp: new Date().toISOString(), action: 'bash_command', message: 'Bash 1', details: 'Bash 1' },
        { timestamp: new Date().toISOString(), action: 'file_write', message: 'File 1', details: 'File 1' },
      ];
      
      for (const entry of entries) {
        await notifier.notify(entry);
      }
      
      const stats = notifier.getStats();
      // All 4 entries should be written since we configured all these event types
      expect(stats.total).toBe(4);
      // security_block (2) = high, bash_command (1) = high, file_write (1) = medium
      expect(stats.bySeverity.high).toBe(3);
      expect(stats.bySeverity.medium).toBe(1);
      expect(stats.bySeverity.low).toBe(0);
      expect(stats.bySeverity.critical).toBe(0);
      expect(stats.byType.security_block).toBe(2);
      expect(stats.byType.bash_command).toBe(1);
      expect(stats.byType.file_operation).toBe(1);
    });
  });

  describe('Default configuration', () => {
    it('should have correct default values', () => {
      expect(DEFAULT_AUDIT_NOTIFIER_CONFIG.enabled).toBe(false);
      expect(DEFAULT_AUDIT_NOTIFIER_CONFIG.minSeverity).toBe('medium');
      expect(DEFAULT_AUDIT_NOTIFIER_CONFIG.eventTypes).toContain('security_block');
      expect(DEFAULT_AUDIT_NOTIFIER_CONFIG.maxRetries).toBe(3);
      expect(DEFAULT_AUDIT_NOTIFIER_CONFIG.webhookTimeout).toBe(5000);
    });
  });

  describe('Global instance', () => {
    it('should have a global instance', () => {
      const { globalAuditNotifier } = require('../../src/modules/security/audit-notifier');
      expect(globalAuditNotifier).toBeInstanceOf(AuditNotifier);
      expect(globalAuditNotifier.isEnabled()).toBe(false);
    });
  });
});
