/**
 * Slash-команды через host wire (split W3b-3).
 *
 * Это не весь каталог CLI: хендлеры команд живут в `src/cli/repl-commands*` и
 * требуют терминальный `CommandServices`/`CommandIO`. Здесь — серверное
 * подмножество, у которого есть однозначная семантика демона: состояние,
 * сессии, модель/конфиг, stop/pause/resume. Неизвестная команда — честная
 * ошибка, а не молчаливый no-op.
 */
import { resolveConfigKey } from "../../../config/registry";
import { applyConfigWrite } from "../../../runtime/config-write";
import type { HostCommandResult } from "../../../core/host";
import type { AgentServiceState } from "../state";
import { interruptSession } from "../api/tasks-control";
import { hostStateOf } from "./host-state";

/** Что умеет wire-подмножество (показывается `/help`). */
const SUPPORTED = [
  "/help",
  "/status",
  "/sessions",
  "/model [name]",
  "/config get <key>",
  "/config set <key> <value>",
  "/stop",
  "/pause",
  "/resume",
];

/** Исполняет slash-команду на рантайме демона. */
export async function runHostCommand(
  s: AgentServiceState,
  sessionId: string,
  line: string,
): Promise<HostCommandResult> {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) {
    return { ok: false, output: [], error: "command must start with /" };
  }
  const tokens = trimmed.slice(1).split(/\s+/);
  const name = tokens[0] ?? "";
  const args = tokens.slice(1);

  switch (name) {
    case "help":
      return { ok: true, output: ["Remote commands:", ...SUPPORTED] };
    case "status": {
      const state = hostStateOf(s, sessionId);
      return {
        ok: true,
        output: [
          `busy: ${state.busy}`,
          `session: ${state.sessionId ?? "—"}`,
          `model: ${state.model ?? "—"}`,
          `provider: ${state.provider ?? "—"}`,
        ],
      };
    }
    case "sessions":
      return {
        ok: true,
        output: (s.deps.sessionManager?.list() ?? []).map((m) => `${m.id}\t${m.name}`),
      };
    case "model":
      if (!args[0]) return { ok: true, output: [`model: ${s.config.model}`] };
      return writeKey(s, "model", args[0]);
    case "config":
      return configCommand(s, args);
    case "stop":
      return { ok: true, output: [`interrupted: ${interruptSession(s, sessionId)}`] };
    case "pause":
      return setPaused(s, sessionId, true);
    case "resume":
      return setPaused(s, sessionId, false);
    default:
      return {
        ok: false,
        output: [],
        error: `command not supported over host wire: /${name}`,
      };
  }
}

async function configCommand(s: AgentServiceState, args: string[]): Promise<HostCommandResult> {
  const [action, key, ...rest] = args;
  if (action === "get" && key) {
    const def = resolveConfigKey(key);
    if (!def) return { ok: false, output: [], error: `unknown key: ${key}` };
    return { ok: true, output: [`${def.key}=${format(def.get(s.config))}`] };
  }
  if (action === "set" && key && rest.length) {
    return writeKey(s, key, rest.join(" "));
  }
  return {
    ok: false,
    output: [],
    error: "usage: /config get <key> | /config set <key> <value>",
  };
}

async function writeKey(
  s: AgentServiceState,
  key: string,
  raw: string,
): Promise<HostCommandResult> {
  if (s.pool.anyBusy()) return { ok: false, output: [], error: "busy" };
  const result = await applyConfigWrite(s.config, key, raw, {
    saveConfig: s.deps.saveConfig,
    reconfigure: s.deps.reconfigure,
  });
  if (!result.ok) return { ok: false, output: [], error: result.error ?? "invalid-value" };
  if (key === "model" || key === "provider.active") void s.models.refresh();
  return { ok: true, output: [`${key}=${result.display ?? raw}`] };
}

function setPaused(s: AgentServiceState, sessionId: string, paused: boolean): HostCommandResult {
  const agent = s.pool.getRunner(sessionId)?.agent as
    { pause?: () => void; resume?: () => void } | undefined;
  if (!agent || typeof agent.pause !== "function" || typeof agent.resume !== "function") {
    return { ok: false, output: [], error: "no active runner for session" };
  }
  if (paused) agent.pause();
  else agent.resume();
  return { ok: true, output: [paused ? "paused" : "resumed"] };
}

function format(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
