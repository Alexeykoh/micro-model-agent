import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

export interface MCPServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MCPTool {
  name: string;
  description: string;
  server: string;
  parameters?: Record<string, unknown>;
}

interface MCPConfig {
  servers: MCPServer[];
}

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

export function listMCPServers(cwd: string): MCPServer[] {
  return loadMCPConfig(cwd).servers;
}

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

export function formatMCPToolList(servers: MCPServer[]): string {
  if (servers.length === 0) {
    return 'No MCP servers configured.\nAdd servers to .mma/mcp.json or .mmrc "mcp" section.';
  }

  const lines: string[] = ['MCP Servers:'];
  for (const s of servers) {
    lines.push(`  ${s.name}: ${s.command} ${(s.args || []).join(' ')}`);
  }
  return lines.join('\n');
}

export function isMCPCommand(cmd: string): boolean {
  return cmd.trim().startsWith('mcp ');
}
