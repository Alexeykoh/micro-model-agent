/**
 * Extended slash-command handlers for `mma web` (Phase 4).
 *
 * Mirrors the REPL semantics of `src/cli/repl-commands.ts` for the subset that
 * is feasible WITHOUT a terminal: reasoning display/level, verbosity, context
 * window + budget shares, session list/activate and session export. Terminal-
 * only commands (`/meet`, `/wizard`, `/init`, interactive prompts, `/provider
 * add`) stay out of scope — they need `PromptIO` / the REPL output channel.
 *
 * Every handler emits plain, colour-free lines (the browser applies its own dim
 * styling) and never throws; errors become a dim `↳ ...` hint.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigValue } from "../../config/registry";
import type { AppConfig } from "../../config/types";
import {
  extensionFor,
  formatExport,
  redactExport,
  sanitizeFileName,
  type ExportFormat,
} from "../session/export";
import { errMsg } from "../../utils/error";
import { applyConfigWrite, withConfig, type Handler, type Out } from "./commands-shared";
import type { WebUiState } from "./state";
import { globalExportsDir } from "../../config/paths";

const REASONING_USAGE = "/reasoning [show|hide|on|off|level <auto|default|none|low|medium|high|max>]";
const CONTEXT_USAGE = "/context [<tokens> | system <share> | reserve <share>]";
const SECURITY_USAGE = "/security [status|<key> [value]]";

/** Handlers merged into the core dispatcher; keyed by lowercased command name. */
export function makeSettingsHandlers(state: WebUiState): Record<string, Handler> {
  return {
    reasoning: (args, o) => withConfig(state, o, (cfg) => reasoningCmd(cfg, args, o, state)),
    verbose: (args, o) => withConfig(state, o, (cfg) => verboseCmd(cfg, args, o, state)),
    context: (args, o) => withConfig(state, o, (cfg) => contextCmd(cfg, args, o, state)),
    security: (args, o) => withConfig(state, o, (cfg) => securityCmd(cfg, args, o, state)),
    session: (args, o) => sessionCmd(state, args, o),
    export: (args, o) => exportCmd(state, args, o),
  };
}

function reasoningCmd(
  cfg: AppConfig,
  args: string[],
  out: Out,
  state: WebUiState,
): void | Promise<void> {
  const sub = args[0]?.trim().toLowerCase();
  if (!sub) {
    const show = cfg.showReasoning ? "on" : "off";
    const mode = cfg.reasoning?.mode ?? "auto";
    out(`reasoning: ${show} · level ${mode}${mode === "auto" ? " (auto)" : ""}`);
    return;
  }
  if (sub === "show" || sub === "on" || sub === "hide" || sub === "off") {
    const on = sub === "show" || sub === "on";
    return applyConfigWrite(cfg, "showReasoning", on ? "on" : "off", out, state);
  }
  if (sub === "level") {
    const lvl = args[1]?.trim().toLowerCase();
    if (!lvl) {
      out(`usage: ${REASONING_USAGE}`);
      return;
    }
    return applyConfigWrite(cfg, "reasoning.mode", lvl, out, state);
  }
  out(`↳ unknown subcommand: reasoning ${sub}`);
  out(`usage: ${REASONING_USAGE}`);
}

function verboseCmd(
  cfg: AppConfig,
  args: string[],
  out: Out,
  state: WebUiState,
): void | Promise<void> {
  const level = args[0]?.trim().toLowerCase();
  if (!level) {
    const r = getConfigValue(cfg, "ui.verbosity");
    out(`verbosity: ${r.ok ? r.display : "—"}`);
    return;
  }
  return applyConfigWrite(cfg, "ui.verbosity", level, out, state);
}

function contextCmd(
  cfg: AppConfig,
  args: string[],
  out: Out,
  state: WebUiState,
): void | Promise<void> {
  if (args.length === 0) {
    const used = state.usage?.contextUsed;
    const limit = state.usage?.contextLimit ?? cfg.contextWindow;
    out(used !== undefined ? `context: ${used} / ${limit} tok` : `context: ${cfg.contextWindow} tok`);
    return;
  }
  if (args[0] === "system" || args[0] === "reserve") {
    const raw = args[1];
    if (!raw) {
      out(`usage: ${CONTEXT_USAGE}`);
      return;
    }
    const key =
      args[0] === "system" ? "contextBudget.systemPrompt" : "contextBudget.responseReserve";
    return applyConfigWrite(cfg, key, raw, out, state);
  }
  if (!/^\d+$/.test(args[0])) {
    out(`↳ unknown argument: ${args[0]}`);
    out(`usage: ${CONTEXT_USAGE}`);
    return;
  }
  return applyConfigWrite(cfg, "contextWindow", args[0], out, state);
}

function securityCmd(
  cfg: AppConfig,
  args: string[],
  out: Out,
  state: WebUiState,
): void | Promise<void> {
  const sub = args[0]?.trim().toLowerCase();
  if (!sub || sub === "status") {
    const flag = (v?: boolean) => (v ? "on" : "off");
    const s = cfg.security;
    out(`security · ${flag(s?.enabled)}`);
    out(`↳ bash ${flag(s?.bash.enabled)} · paths ${flag(s?.paths.enabled)} · network ${flag(s?.network.enabled)}`);
    out(
      `↳ contentScan ${flag(s?.contentScan.enabled)} · encryption ${flag(s?.sessionEncryption.enabled)}`,
    );
    return;
  }
  if (args.length >= 2) {
    return applyConfigWrite(cfg, args[0], args.slice(1).join(" "), out, state);
  }
  out(`↳ unknown subcommand: security ${args[0]}`);
  out(`usage: ${SECURITY_USAGE}`);
}

function sessionCmd(state: WebUiState, args: string[], out: Out): void {
  const mgr = state.sessionManager;
  if (!mgr) {
    out("↳ sessions unavailable");
    return;
  }
  const [sub, ...rest] = args;
  if (!sub || sub === "list") {
    const sessions = mgr.list();
    if (sessions.length === 0) {
      out("no sessions");
      return;
    }
    const active = mgr.getActive();
    for (const s of sessions) {
      const marker = s.id === active ? "* " : "  ";
      out(`${marker}${s.id.slice(0, 12)}  ${s.name}  (${s.messageCount} msgs)`);
    }
    return;
  }
  if (sub === "use") {
    const query = rest.join(" ").trim();
    if (!query) {
      out("usage: /session use <id>");
      return;
    }
    const match = mgr
      .list()
      .find(
        (s) =>
          s.id === query ||
          s.id.startsWith(query) ||
          s.name.toLowerCase().includes(query.toLowerCase()),
      );
    if (!match) {
      out(`↳ no matching session: ${query}`);
      return;
    }
    try {
      mgr.setActive(match.id);
    } catch (err) {
      out(`↳ ${errMsg(err)}`);
      return;
    }
    out(`active session: ${match.name} (${match.id.slice(0, 12)})`);
    return;
  }
  out(`↳ unknown subcommand: session ${sub}`);
}

function exportCmd(state: WebUiState, args: string[], out: Out): void {
  const mgr = state.sessionManager;
  if (!mgr) {
    out("↳ sessions unavailable");
    return;
  }
  let format: ExportFormat = "md";
  let outPath: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out") {
      const v = args[++i];
      if (v === undefined) {
        out("↳ --out requires a value");
        return;
      }
      outPath = v;
    } else {
      positional.push(a);
    }
  }
  const first = positional[0]?.toLowerCase();
  if (first === "md" || first === "json" || first === "jsonl") format = first;
  else if (first) {
    out(`↳ unknown format: ${positional[0]}`);
    return;
  }
  if (!mgr.getHistory || !mgr.loadSessionLog) {
    out("↳ export unavailable: this web session store does not expose history");
    return;
  }
  const active = mgr.getActive();
  const match = active ? mgr.get(active) : null;
  if (!active || !match) {
    out("↳ no active session");
    return;
  }
  const messages = mgr.getHistory(active);
  const log = mgr.loadSessionLog(active);
  if (format === "jsonl" ? log.length === 0 : messages.length === 0) {
    out("↳ nothing to export");
    return;
  }
  const text = redactExport(formatExport({ meta: match, messages, log }, format), true);
  const dir = outPath ? dirname(outPath) : globalExportsDir();
  const path =
    outPath ??
    join(dir, `${sanitizeFileName(match.name)}-${match.id.slice(0, 8)}.${extensionFor(format)}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, text, "utf-8");
  } catch (err) {
    out(`↳ export failed: ${errMsg(err)}`);
    return;
  }
  out(`exported ${format} → ${path}`);
}
