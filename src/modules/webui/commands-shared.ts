/**
 * Shared plumbing for the `mma web` slash-command handlers (Phase 4).
 *
 * Both the core dispatcher (`commands.ts`) and the extended settings handlers
 * (`commands-settings.ts`) go through the SAME write path: the config registry
 * (`setConfigValue`), the host's `saveConfig`/`reconfigure` hooks. Keeping the
 * helpers here avoids an import cycle between the two handler modules.
 */
import type { AppConfig } from "../../config/types";
import { setConfigValue } from "../../config/registry";
import type { WebUiState } from "./state";

export type Out = (line: string) => void;
export type Handler = (args: string[], out: Out) => void | Promise<void>;

/** Run `fn` only when a config collaborator is wired; otherwise emit a hint. */
export function withConfig(
  state: WebUiState,
  out: Out,
  fn: (cfg: AppConfig) => void | Promise<void>,
): void | Promise<void> {
  if (!state.config) {
    out("↳ config unavailable");
    return;
  }
  return fn(state.config);
}

export function activeMeta(state: WebUiState) {
  const id = state.sessionManager?.getActive();
  return id ? (state.sessionManager?.get(id) ?? null) : null;
}

export function configErrorText(reason: string, input: string, key?: string): string {
  const target = key ?? input;
  switch (reason) {
    case "unknown-key":
      return `unknown key: ${input}`;
    case "read-only":
      return `${target} is read-only`;
    case "range":
      return `value out of range for ${target}`;
    case "combined":
      return "shares exceed the combined limit";
    default:
      return `invalid value for ${target}`;
  }
}

/** Persist + reconfigure after a successful registry write, then report. */
export async function applyConfigWrite(
  cfg: AppConfig,
  name: string,
  value: string,
  out: Out,
  state: WebUiState,
): Promise<void> {
  const result = setConfigValue(cfg, name, value);
  if (!result.ok) {
    out(`↳ ${configErrorText(result.reason, result.input, result.key)}`);
    return;
  }
  let note = "saved";
  try {
    state.saveConfig?.(cfg);
  } catch {
    note = "not persisted";
  }
  if (result.reconfigure && state.reconfigure) {
    try {
      await state.reconfigure(cfg);
    } catch {
      note = `${note}; reconfigure failed`;
    }
  }
  out(`${result.key} = ${result.display} · ${note}`);
}
