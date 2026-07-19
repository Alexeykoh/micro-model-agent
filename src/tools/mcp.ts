import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Интеграция с MCP (Model Context Protocol) серверами.
 *
 * Позволяет агенту вызывать инструменты внешних MCP-серверов.
 * Конфигурация в .mma/mcp.json или .mmrc (секция mcp).
 *
 * Формат вызова: bash "mcp <server> <tool> [args_json]"
 *
 * @module tools/mcp
 */

/** Определение MCP-сервера */
export interface MCPServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Определение MCP-инструмента */
export interface MCPTool {
  name: string;
  description: string;
  server: string;
  parameters?: Record<string, unknown>;
}

interface MCPConfig {
  servers: MCPServer[];
}

/** Загружает конфигурацию MCP из .mma/mcp.json или .mmrc */
function loadMCPConfig(cwd: string): MCPConfig {
  // Check .mma/mcp.json
  const localPath = join(cwd, '.mma', 'mcp.json');
  if (existsSync(localPath)) {
    try {
      return JSON.parse(readFileSync(localPath, 'utf-8'));
    } catch { /* ignore */ }
  }

  // Check .mmrc mcp section
  const rcPath = join(cwd, '.mmrc');
  if (existsSync(rcPath)) {
    try {
      const rc = JSON.parse(readFileSync(rcPath, 'utf-8'));
      if (rc.mcp) return rc.mcp;
    } catch { /* ignore */ }
  }

  return { servers: [] };
}

/** Возвращает список MCP-серверов из конфигурации */
export function listMCPServers(cwd: string): MCPServer[] {
  return loadMCPConfig(cwd).servers;
}

/** Вызывает инструмент MCP-сервера через npx mcp-client */
export function callMCPTool(cwd: string, serverName: string, toolName: string, args: Record<string, unknown>): string {
  const config = loadMCPConfig(cwd);
  const server = config.servers.find(s => s.name === serverName);

  if (!server) {
    return `Error: MCP server "${serverName}" not found. Available: ${config.servers.map(s => s.name).join(', ')}`;
  }

  try {
    // Build command
    const argsJson = JSON.stringify(args);
    const cmd = `${server.command} ${server.args?.join(' ') || ''} call ${toolName} '${argsJson}'`;

    const env = { ...process.env, ...server.env };
    const result = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 30000,
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return result || '(no output)';
  } catch (e: any) {
    return `MCP error: ${e.message}`;
  }
}

export function parseMCPCommand(cmd: string): { server: string; tool: string; args: Record<string, unknown> } | null {
  // Format: mcp <server> <tool> [args_json]
  const match = cmd.match(/^mcp\s+(\S+)\s+(\S+)\s*(.*)?$/);
  if (!match) return null;

  const [, server, tool, argsStr] = match;
  let args: Record<string, unknown> = {};

  if (argsStr) {
    try {
      args = JSON.parse(argsStr);
    } catch {
      // Try key=value format
      for (const part of argsStr.split(/\s+/)) {
        const [key, ...valueParts] = part.split('=');
        if (key && valueParts.length > 0) {
          args[key] = valueParts.join('=');
        }
      }
    }
  }

  return { server, tool, args };
}

import { getTheme } from '../styling/index.js';

export function formatMCPToolList(servers: MCPServer[]): string {
  const theme = getTheme();
  if (servers.length === 0) {
    return 'No MCP servers configured.\nAdd servers to .mma/mcp.json or .mmrc "mcp" section.';
  }

  const lines: string[] = [theme.heading('MCP Servers:')];
  for (const s of servers) {
    lines.push(`  ${theme.toolName(s.name)}: ${s.command} ${(s.args || []).join(' ')}`);
  }
  return lines.join('\n');
}

export function isMCPCommand(cmd: string): boolean {
  return cmd.trim().startsWith('mcp ');
}
