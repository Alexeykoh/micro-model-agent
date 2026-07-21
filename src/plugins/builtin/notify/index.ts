import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import type { AgentPlugin, PluginContext } from '../../types.js';

/**
 * Плагин notify — OS desktop-уведомления.
 *
 * Отправляет toast-уведомление при:
 * - agent:done — задача выполнена
 * - tool:blocked — агент заблокирован
 * - tool:after (question) — агент ждёт ответа
 *
 * Zero-dependency: shell-out по платформе.
 * - win32: PowerShell NotifyIcon balloon tip
 * - darwin: osascript display notification
 * - linux: notify-send
 *
 * @module plugins/builtin/notify
 */

function sendNotification(title: string, body: string): void {
  const p = platform();
  try {
    if (p === 'win32') {
      // PowerShell: System.Windows.Forms.NotifyIcon balloon tip
      const psScript = `Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(5000, '${title.replace(/'/g, "''")}', '${body.replace(/'/g, "''")}', [System.Windows.Forms.ToolTipIcon]::Info)`;
      execSync(`powershell -Command "${psScript}"`, {
        timeout: 5000,
        windowsHide: true,
        stdio: 'pipe',
      });
    } else if (p === 'darwin') {
      execSync(`osascript -e 'display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"'`, {
        timeout: 5000,
        stdio: 'pipe',
      });
    } else {
      // Linux
      execSync(`notify-send "${title.replace(/"/g, '\\"')}" "${body.replace(/"/g, '\\"')}"`, {
        timeout: 5000,
        stdio: 'pipe',
      });
    }
  } catch {
    // Best-effort — если уведомление не отправлено, не крашимся
  }
}

export default function createNotify(): AgentPlugin {
  let ctx: PluginContext | null = null;
  let config = { onDone: true, onBlocked: true, onQuestion: true };

  return {
    name: 'notify',
    version: '1.0.0',
    description: 'OS desktop notifications for agent events',

    onActivate(pluginCtx: PluginContext) {
      ctx = pluginCtx;
      // Мержим конфиг из manifest + user override
      if (pluginCtx.config) {
        config = { ...config, ...pluginCtx.config as Record<string, unknown> } as typeof config;
      }
      pluginCtx.logger.info(`notify: active (done=${config.onDone}, blocked=${config.onBlocked}, question=${config.onQuestion})`);
    },

    onDeactivate() {
      ctx = null;
    },

    getPromptSection() {
      return '## Notify Plugin\nDesktop notifications are enabled. You don\'t need to notify the user about completion — it happens automatically.';
    },
  };
}

/**
 * Обработчики событий — вызываются извне через PluginManager.on().
 * Экспортируются для регистрации в loop.ts.
 */
export function handleAgentDone(): void {
  sendNotification('MMA', 'Agent finished the task');
}

export function handleToolBlocked(toolName: string, _args: unknown): void {
  sendNotification('MMA', `Tool blocked: ${toolName}`);
}

export function handleToolAfter(toolName: string, _args: unknown, result: { exitCode: number }): void {
  // Question tool — агент ждёт ответа
  if (toolName === 'question') {
    sendNotification('MMA', 'Agent needs your answer');
  }
}