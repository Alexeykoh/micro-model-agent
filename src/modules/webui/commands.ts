/**
 * Slash-command dispatcher for `mma web` (Phase 3 Task E).
 *
 * The browser's `/` path used to be a documented no-op. This module runs a
 * supported subset through a handler map (architecture rule #17 — no `if`
 * chain) and reuses the SAME machinery as the REPL: the config registry
 * (`getConfigValue`/`setConfigValue`), the host's `saveConfig`/`reconfigure`
 * hooks and the shared memory store. Output is emitted line-by-line over SSE as
 * a `command` event and rendered dim in the feed.
 *
 * Terminal-only commands (`/meet`, interactive prompts, `/wizard`) are
 * deliberately out of scope — see `HELP` for the supported subset.
 */
import type { AppConfig } from "../../config/types";
import { canonicalKeys, getConfigValue } from "../../config/registry";
import { redactContextSecrets } from "../../core/agent/context-log";
import { errMsg } from "../../utils/error";
import { memoryLines } from "./memory-commands";
import { makeSettingsHandlers } from "./commands-settings";
import { activeMeta, applyConfigWrite, withConfig, type Handler, type Out } from "./commands-shared";
import { broadcast, type WebUiState } from "./state";

/** Supported subset, surfaced by `/help` (one line each). */
const HELP: Array<{ usage: string; desc: string }> = [
  { usage: "/help", desc: "list web commands" },
  { usage: "/status", desc: "model · provider · context · session · verbosity" },
  { usage: "/config <key> [value]", desc: "read or write a config key" },
  { usage: "/model list | /model use <name>", desc: "list or switch model" },
  { usage: "/provider list | /provider use <name>", desc: "list or switch provider" },
  { usage: "/reasoning [show|hide|on|off|level <lvl>]", desc: "reasoning display and level" },
  { usage: "/verbose <quiet|normal|verbose>", desc: "set UI verbosity" },
  { usage: "/context [<tokens>]", desc: "show or set the context window" },
  { usage: "/session list | /session use <id>", desc: "list or activate a session" },
  { usage: "/export [md|json|jsonl]", desc: "export the active session to a file" },
  { usage: "/memory [get|set|unset|find|forget]", desc: "inspect or edit global memory" },
  { usage: "/clear", desc: "clear the feed (browser-side)" },
  { usage: "/new", desc: "open a new chat tab (browser-side)" },
];

/** `GET /api/commands` payload: name + usage + desc per supported command. */
export function webCommandList(): Array<{ name: string; usage: string; desc: string }> {
  return HELP.map((h) => ({
    name: h.usage.slice(1).split(/[\s|]/)[0],
    usage: h.usage,
    desc: h.desc,
  }));
}

export interface WebCommandDeps {
  state: WebUiState;
  /** Capture sink for tests; defaults to an SSE `command` broadcast. */
  emit?: (text: string) => void;
}

/** Build the `(line) => Promise<void>` dispatcher wired into `WebHost`. */
export function makeWebCommands(deps: WebCommandDeps): (line: string) => Promise<void> {
  const { state } = deps;
  const raw =
    deps.emit ??
    ((text: string) => broadcast({ type: "command", ts: Date.now(), text }, state));
  // Every emitted line passes through point-redaction: config reads can echo a
  // key the user just set, and the feed is user-visible.
  const out: Out = (text) => raw(redactContextSecrets(text));

  const handlers: Record<string, Handler> = {
    help: (_args, o) => HELP.forEach((h) => o(`${h.usage}  ·  ${h.desc}`)),
    status: (_args, o) => withConfig(state, o, (cfg) => status(cfg, state, o)),
    config: (args, o) => withConfig(state, o, (cfg) => configCmd(cfg, args, o, state)),
    model: (args, o) => withConfig(state, o, (cfg) => modelCmd(cfg, args, o, state)),
    provider: (args, o) => withConfig(state, o, (cfg) => providerCmd(cfg, args, o, state)),
    memory: (args, o) => memoryCmd(state, args, o),
    ...makeSettingsHandlers(state),
  };

  return async (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("/")) return;
    const parts = trimmed.slice(1).trim().split(/\s+/);
    const name = (parts.shift() ?? "").toLowerCase();
    if (!name) return;
    const handler = handlers[name];
    if (!handler) {
      out(`↳ unknown command: ${name}`);
      return;
    }
    try {
      await handler(parts, out);
    } catch (err) {
      out(`↳ ${errMsg(err)}`);
    }
  };
}

/** One-line status: model · provider · context · session · verbosity (+ environment). */
function status(cfg: AppConfig, state: WebUiState, out: Out): void {
  const provider = cfg.provider.active ?? cfg.provider.type;
  const parts = [cfg.model, provider, `${cfg.contextWindow} tok`];
  const meta = activeMeta(state);
  if (meta) parts.push(`${meta.name} (${meta.messageCount} msgs)`);
  const verbosity = getConfigValue(cfg, "ui.verbosity");
  parts.push(verbosity.ok ? verbosity.display : "—");
  out(parts.join(" · "));
  if (state.workspace) out(`dir: ${state.workspace}`);
  if (state.agentsMd) {
    if (state.agentsMd.disabled) out("AGENTS.md: disabled");
    else if (state.agentsMd.files.length) out(`AGENTS.md: ${state.agentsMd.files.join(", ")}`);
    else out("AGENTS.md: not found");
  }
  if (state.projectMapStats) {
    const map = state.projectMapStats();
    out(map ? `map: ${map.files} file(s) · ${map.symbols} sym · ~${map.tokens} tok` : "map: not indexed");
  }
}

/** Persist + reconfigure after a successful registry write, then report. */
async function configCmd(
  cfg: AppConfig,
  args: string[],
  out: Out,
  state: WebUiState,
): Promise<void> {
  if (args.length === 0) {
    for (const key of canonicalKeys()) {
      const r = getConfigValue(cfg, key);
      if (r.ok) out(`${key} = ${r.display}`);
    }
    return;
  }
  const [key, ...rest] = args;
  if (rest.length === 0) {
    const r = getConfigValue(cfg, key);
    out(r.ok ? `${r.key} = ${r.display}` : `↳ unknown key: ${key}`);
    return;
  }
  await applyConfigWrite(cfg, key, rest.join(" "), out, state);
}

async function modelCmd(
  cfg: AppConfig,
  args: string[],
  out: Out,
  state: WebUiState,
): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === "list") {
    out(`current: ${cfg.model}`);
    const models = state.knownModels?.() ?? [];
    if (models.length === 0) {
      out("↳ no models reported by provider");
      return;
    }
    for (const m of models) out(`${m === cfg.model ? "* " : "  "}${m}`);
    return;
  }
  if (sub === "use") {
    const name = rest[0];
    if (!name) {
      out("usage: /model use <name>");
      return;
    }
    await applyConfigWrite(cfg, "model", name, out, state);
    return;
  }
  out(`↳ unknown subcommand: model ${sub}`);
}

async function providerCmd(
  cfg: AppConfig,
  args: string[],
  out: Out,
  state: WebUiState,
): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === "list") {
    const active = cfg.provider.active ?? cfg.provider.type;
    const entries = cfg.provider.entries?.length
      ? cfg.provider.entries
      : [{ type: cfg.provider.type, label: active }];
    for (const e of entries) {
      const name = e.label ?? e.type;
      out(`${name === active ? "* " : "  "}${name} (${e.type})`);
    }
    return;
  }
  if (sub === "use") {
    const name = rest[0];
    if (!name) {
      out("usage: /provider use <name>");
      return;
    }
    await applyConfigWrite(cfg, "provider.active", name, out, state);
    return;
  }
  out(`↳ unknown subcommand: provider ${sub}`);
}

function memoryCmd(state: WebUiState, args: string[], out: Out): void {
  if (!state.memory) {
    out("↳ memory unavailable");
    return;
  }
  for (const line of memoryLines(state.memory, args)) out(line);
}
