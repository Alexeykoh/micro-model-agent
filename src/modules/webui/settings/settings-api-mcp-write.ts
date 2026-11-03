/**
 * Чистые операции над MCP-записями: валидация, пополевой патч, CRUD.
 * Вынесено из `settings-api.ts` (правило 6).
 */
import type { AppConfig, MCPServerConfigEntry } from "../../../config/types";
import {
  applyFields,
  asStringArray,
  asStringRecord,
  isRecord,
  setTrimmed,
  validTimeout,
  type FieldApplier,
} from "./settings-api-fields";

/** Транспорты записи MCP-сервера (`MCPServerConfigEntry`). */
const MCP_TRANSPORTS = ["stdio", "sse", "http"] as const;

/** Итог записи MCP: id или код ошибки. */
export type McpWriteResult = { ok: true; id: string } | { ok: false; error: string };

/** Проверка когерентности смёрженной MCP-записи: транспорт vs command/url + таймаут. */
function validateMcpEntry(entry: MCPServerConfigEntry): string | null {
  const transport = entry.transport ?? "stdio";
  if (!(MCP_TRANSPORTS as readonly string[]).includes(transport)) return "invalid-transport";
  if (transport === "stdio") {
    if (!entry.command?.trim()) return "command-required";
  } else if (!entry.url?.trim()) {
    return "url-required";
  }
  if (entry.timeout !== undefined && !validTimeout(entry.timeout)) return "invalid-timeout";
  return null;
}

/** Пополевые MCP-апплаеры (правило #17: таблица, без `if`-цепочки). */
const MCP_FIELD_APPLIERS: Record<string, FieldApplier<MCPServerConfigEntry>> = {
  name: (next, v) => {
    if (typeof v !== "string" || !v.trim()) return "name-required";
    next.name = v.trim();
    return null;
  },
  transport: (next, v) => {
    if (typeof v !== "string") return "invalid-transport";
    next.transport = v as MCPServerConfigEntry["transport"];
    return null;
  },
  command: (next, v) =>
    setTrimmed(v, "invalid-command", (t) => { next.command = t; }, () => { delete next.command; }),
  url: (next, v) =>
    setTrimmed(v, "invalid-url", (t) => { next.url = t; }, () => { delete next.url; }),
  args: (next, v) => {
    const args = asStringArray(v);
    if (!args) return "invalid-args";
    next.args = args;
    return null;
  },
  env: (next, v) => {
    const env = asStringRecord(v);
    if (!env) return "invalid-env";
    next.env = env;
    return null;
  },
  headers: (next, v) => {
    const headers = asStringRecord(v);
    if (!headers) return "invalid-headers";
    next.headers = headers;
    return null;
  },
  enabled: (next, v) => {
    if (typeof v !== "boolean") return "invalid-enabled";
    next.enabled = v;
    return null;
  },
  timeout: (next, v) => {
    if (!validTimeout(v)) return "invalid-timeout";
    next.timeout = v;
    return null;
  },
};

function applyMcpPatch(
  next: MCPServerConfigEntry,
  patch: Record<string, unknown>,
): string | null {
  return applyFields(next, patch, MCP_FIELD_APPLIERS);
}

/**
 * Чистое создание: валидирует `input` и кладёт запись под тримменным именем.
 * Секреты значениями не эхом — вызывающий рендерит маскированный `mcpList`-вид.
 */
export function createMcpServer(config: AppConfig, input: unknown): McpWriteResult {
  if (!isRecord(input)) return { ok: false, error: "invalid-input" };
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, error: "name-required" };
  if (!config.mcpServers) config.mcpServers = {};
  if (config.mcpServers[name]) return { ok: false, error: "name-conflict" };
  const next: MCPServerConfigEntry = { name };
  const patchError = applyMcpPatch(next, { ...input, name });
  if (patchError) return { ok: false, error: patchError };
  const coherent = validateMcpEntry(next);
  if (coherent) return { ok: false, error: coherent };
  config.mcpServers[name] = next;
  return { ok: true, id: name };
}

/** Чистая полная/частичная правка MCP-записи (ключ остаётся `id`). */
export function updateMcpServer(
  config: AppConfig,
  id: string,
  patch: unknown,
): McpWriteResult {
  const current = config.mcpServers?.[id];
  if (!current) return { ok: false, error: "not_found" };
  if (!isRecord(patch)) return { ok: false, error: "invalid-input" };
  const next: MCPServerConfigEntry = { ...current };
  const patchError = applyMcpPatch(next, patch);
  if (patchError) return { ok: false, error: patchError };
  const coherent = validateMcpEntry(next);
  if (coherent) return { ok: false, error: coherent };
  config.mcpServers[id] = next;
  return { ok: true, id };
}

/** Чистое удаление MCP-записи. */
export function deleteMcpServer(config: AppConfig, id: string): McpWriteResult {
  if (!config.mcpServers?.[id]) return { ok: false, error: "not_found" };
  delete config.mcpServers[id];
  return { ok: true, id };
}
