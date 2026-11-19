/**
 * MCP-серверы в форме для UI (split W4b-3): тот же вид, что у настроек web.
 * Зависит только от конфига, поэтому живёт в runtime и годится host wire.
 */
import type { MCPServerConfigEntry, AppConfig } from "../config/types";

/** MCP-сервер проекта в форме для UI. */
export interface McpServerView {
  id: string;
  name: string;
  status: string;
  transport?: string;
  command?: string;
  url?: string;
  args?: string[];
  timeout?: number;
  enabled?: boolean;
  envKeys: string[];
  headerKeys: string[];
}

function viewOptionals(cfg: MCPServerConfigEntry): Partial<McpServerView> {
  const out: Partial<McpServerView> = {};
  if (cfg.transport) out.transport = cfg.transport;
  if (cfg.command) out.command = cfg.command;
  if (cfg.url) out.url = cfg.url;
  if (cfg.args) out.args = [...cfg.args];
  if (cfg.timeout !== undefined) out.timeout = cfg.timeout;
  if (cfg.enabled !== undefined) out.enabled = cfg.enabled;
  return out;
}

/** Список MCP-серверов проекта (секреты не раскрываются, только ключи). */
export function mcpServersView(config: AppConfig | undefined): McpServerView[] {
  const servers = config?.mcpServers ?? {};
  return Object.entries(servers).map(([key, cfg]) => ({
    id: key,
    name: cfg.name || key,
    status: cfg.enabled === false ? "disabled" : "enabled",
    envKeys: cfg.env ? Object.keys(cfg.env) : [],
    headerKeys: cfg.headers ? Object.keys(cfg.headers) : [],
    ...viewOptionals(cfg),
  }));
}
