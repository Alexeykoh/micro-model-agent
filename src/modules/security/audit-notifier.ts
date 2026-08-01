import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import fetch from 'node-fetch';
import type { AuditLogEntry } from './audit-log';

/**
 * Audit notification configuration
 */
export interface AuditNotifierConfig {
  /**
   * Enable audit notifications
   */
  enabled: boolean;
  /**
   * File path for audit notifications log
   * Default: ~/.mma/logs/audit-notifications.jsonl
   */
  filePath?: string;
  /**
   * Webhook URL for real-time notifications
   */
  webhookUrl?: string;
  /**
   * Webhook timeout in milliseconds
   * Default: 5000
   */
  webhookTimeout?: number;
  /**
   * Minimum severity level to notify
   * 'low' | 'medium' | 'high' | 'critical'
   */
  minSeverity?: AuditSeverity;
  /**
   * Notify on these event types
   */
  eventTypes?: AuditEventType[];
  /**
   * Retry count for webhook failures
   * Default: 3
   */
  maxRetries?: number;
}

/**
 * Audit event severity levels
 */
export type AuditSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * Audit event types
 */
export type AuditEventType = 
  | 'tool_call'
  | 'tool_result'
  | 'bash_command'
  | 'file_operation'
  | 'network_request'
  | 'security_block'
  | 'authentication'
  | 'configuration_change'
  | 'session_start'
  | 'session_end';

/**
 * Audit notification entry
 */
export interface AuditNotification {
  timestamp: string;
  eventType: AuditEventType;
  severity: AuditSeverity;
  message: string;
  details?: Record<string, unknown>;
  sessionId?: string;
  userId?: string;
}

/**
 * Severity weights for comparison
 */
const SEVERITY_WEIGHTS: Record<AuditSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Default audit notifier configuration
 */
export const DEFAULT_AUDIT_NOTIFIER_CONFIG: Required<AuditNotifierConfig> = {
  enabled: false,
  filePath: join(homedir(), '.mma', 'logs', 'audit-notifications.jsonl'),
  webhookUrl: undefined,
  webhookTimeout: 5000,
  minSeverity: 'medium',
  eventTypes: [
    'security_block',
    'bash_command',
    'file_operation',
    'network_request',
    'authentication',
    'configuration_change',
  ],
  maxRetries: 3,
};

/**
 * Audit notifier for sending notifications about security events
 */
export class AuditNotifier {
  private config: Required<AuditNotifierConfig>;
  private retryQueue: Array<{ entry: AuditNotification; retries: number }> = [];
  private isProcessing: boolean = false;

  constructor(config?: Partial<AuditNotifierConfig>) {
    this.config = { ...DEFAULT_AUDIT_NOTIFIER_CONFIG, ...config };
    this.ensureLogDirectory();
  }

  /**
   * Check if notifier is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Enable the notifier
   */
  enable(): void {
    this.config.enabled = true;
  }

  /**
   * Disable the notifier
   */
  disable(): void {
    this.config.enabled = false;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<AuditNotifierConfig>): void {
    this.config = { ...this.config, ...config };
    this.ensureLogDirectory();
  }

  /**
   * Ensure the log directory exists
   */
  private ensureLogDirectory(): void {
    if (this.config.filePath) {
      const dir = dirname(this.config.filePath);
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Check if an event type should be notified
   */
  shouldNotify(eventType: AuditEventType): boolean {
    if (!this.config.enabled) return false;
    return this.config.eventTypes.includes(eventType);
  }

  /**
   * Check if a severity level should be notified
   */
  shouldNotifySeverity(severity: AuditSeverity): boolean {
    const minWeight = SEVERITY_WEIGHTS[this.config.minSeverity];
    const eventWeight = SEVERITY_WEIGHTS[severity];
    return eventWeight >= minWeight;
  }

  /**
   * Send a notification for an audit event
   */
  async notify(entry: AuditLogEntry): AuditNotification | null {
    if (!this.config.enabled) return null;
    
    const eventType = this.mapEventType(entry.type);
    if (!eventType || !this.shouldNotify(eventType)) return null;
    
    const severity = this.determineSeverity(entry);
    if (!this.shouldNotifySeverity(severity)) return null;
    
    const notification: AuditNotification = {
      timestamp: entry.timestamp || new Date().toISOString(),
      eventType,
      severity,
      message: entry.message,
      details: entry.details,
      sessionId: entry.sessionId,
      userId: entry.userId,
    };

    // Write to file
    this.writeToFile(notification);
    
    // Send to webhook if configured
    if (this.config.webhookUrl) {
      await this.sendToWebhook(notification);
    }
    
    return notification;
  }

  /**
   * Map audit log entry type to notification event type
   */
  private mapEventType(type: string): AuditEventType | null {
    const typeMap: Record<string, AuditEventType> = {
      'tool_call': 'tool_call',
      'tool_result': 'tool_result',
      'bash': 'bash_command',
      'file_read': 'file_operation',
      'file_write': 'file_operation',
      'file_delete': 'file_operation',
      'file_edit': 'file_operation',
      'network_request': 'network_request',
      'security_block': 'security_block',
      'auth': 'authentication',
      'config_change': 'configuration_change',
      'session_start': 'session_start',
      'session_end': 'session_end',
    };
    return typeMap[type] || null;
  }

  /**
   * Determine severity from audit log entry
   */
  private determineSeverity(entry: AuditLogEntry): AuditSeverity {
    if (entry.severity && SEVERITY_WEIGHTS[entry.severity as AuditSeverity]) {
      return entry.severity as AuditSeverity;
    }
    
    // Default severity based on event type
    const typeSeverity: Record<string, AuditSeverity> = {
      'security_block': 'high',
      'bash': 'high',
      'file_delete': 'medium',
      'file_edit': 'medium',
      'network_request': 'medium',
      'auth': 'high',
      'config_change': 'medium',
      'session_start': 'low',
      'session_end': 'low',
    };
    
    return typeSeverity[entry.type] || 'low';
  }

  /**
   * Write notification to file
   */
  private writeToFile(notification: AuditNotification): void {
    if (!this.config.filePath) return;
    
    try {
      const line = JSON.stringify(notification);
      appendFileSync(this.config.filePath, line + '\n', 'utf8');
    } catch (error) {
      console.error('[AuditNotifier] Failed to write to file:', error);
    }
  }

  /**
   * Send notification to webhook
   */
  private async sendToWebhook(notification: AuditNotification): Promise<void> {
    if (!this.config.webhookUrl) return;
    
    try {
      const response = await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notification),
        timeout: this.config.webhookTimeout,
      });
      
      if (!response.ok) {
        throw new Error(`Webhook returned ${response.status}`);
      }
    } catch (error) {
      console.error('[AuditNotifier] Webhook failed, adding to retry queue:', error);
      this.addToRetryQueue(notification);
    }
  }

  /**
   * Add notification to retry queue
   */
  private addToRetryQueue(notification: AuditNotification): void {
    this.retryQueue.push({ entry: notification, retries: 0 });
    if (!this.isProcessing) {
      this.processRetryQueue();
    }
  }

  /**
   * Process the retry queue
   */
  private async processRetryQueue(): Promise<void> {
    if (this.retryQueue.length === 0 || this.isProcessing) return;
    
    this.isProcessing = true;
    
    while (this.retryQueue.length > 0) {
      const item = this.retryQueue[0];
      
      if (item.retries >= this.config.maxRetries) {
        console.error('[AuditNotifier] Max retries exceeded for notification:', item.entry);
        this.retryQueue.shift();
        continue;
      }
      
      try {
        await this.sendToWebhook(item.entry);
        this.retryQueue.shift();
      } catch (error) {
        item.retries++;
        // Exponential backoff
        const delay = Math.pow(2, item.retries) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    this.isProcessing = false;
  }

  /**
   * Read notifications from file
   */
  readNotifications(limit: number = 100): AuditNotification[] {
    if (!this.config.filePath || !existsSync(this.config.filePath)) {
      return [];
    }
    
    try {
      const content = readFileSync(this.config.filePath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      return lines.slice(-limit).map(line => JSON.parse(line) as AuditNotification);
    } catch {
      return [];
    }
  }

  /**
   * Clear all notifications
   */
  clearNotifications(): void {
    if (this.config.filePath) {
      writeFileSync(this.config.filePath, '', 'utf8');
    }
    this.retryQueue = [];
  }

  /**
   * Get notification statistics
   */
  getStats(): { total: number; bySeverity: Record<AuditSeverity, number>; byType: Record<AuditEventType, number> } {
    const notifications = this.readNotifications();
    const bySeverity: Record<AuditSeverity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    const byType: Record<AuditEventType, number> = {
      tool_call: 0,
      tool_result: 0,
      bash_command: 0,
      file_operation: 0,
      network_request: 0,
      security_block: 0,
      authentication: 0,
      configuration_change: 0,
      session_start: 0,
      session_end: 0,
    };
    
    for (const n of notifications) {
      bySeverity[n.severity] = (bySeverity[n.severity] || 0) + 1;
      byType[n.eventType] = (byType[n.eventType] || 0) + 1;
    }
    
    return {
      total: notifications.length,
      bySeverity,
      byType,
    };
  }
}

/**
 * Global audit notifier instance
 */
export const globalAuditNotifier = new AuditNotifier();

/**
 * Create an audit notifier with custom configuration
 */
export function createAuditNotifier(config?: Partial<AuditNotifierConfig>): AuditNotifier {
  return new AuditNotifier(config);
}

// Import readFileSync for readNotifications
import { readFileSync } from 'fs';
