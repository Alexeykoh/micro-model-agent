import type { AgentPlugin } from "../modules/types";

export interface ScopeRequest {
  files: string[];
  read_only: boolean;
  reason: string;
}

const WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "delete_file",
  "create_dir",
  "move_file",
  "download_file",
]);

/**
 * Scope denials funnel through i18n keys file.path_not_allowed(_short)
 * ("Path not allowed" / "Путь недопустим") and chunk-query's "[SCOPE]" prefix.
 */
export function isPathDenialOutput(output: string | undefined): boolean {
  if (!output) return false;
  return (
    output.includes("Path not allowed") ||
    output.includes("Путь недопустим") ||
    output.startsWith("[SCOPE]")
  );
}

interface DeniedPath {
  path: string;
  write: boolean;
}

function pathArgOf(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  for (const key of ["path", "file", "input_path", "target", "source", "destination", "dir"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const v of Object.values(args)) {
    if (typeof v === "string" && /\.[\w-]+$/.test(v)) return v.trim();
  }
  return "";
}

/** Observes the sub-agent's tool results and records scope-denied paths. */
export class ScopeDenialCollector {
  private denied = new Map<string, DeniedPath>();

  readonly plugin: AgentPlugin = {
    name: "scope-denial-collector",
    isBuiltin: true,
    onAfterTool: (_ctx, call, result) => {
      const name = (call as any)?.name as string | undefined;
      if (!name || !result || result.success) return;
      if (!isPathDenialOutput(typeof result.output === "string" ? result.output : undefined)) {
        return;
      }
      const path = pathArgOf((call as any)?.arguments);
      if (!path) return;
      const write = WRITE_TOOLS.has(name);
      this.denied.set(path, { path, write });
    },
  };

  getDenied(): DeniedPath[] {
    return Array.from(this.denied.values());
  }

  /** read_only=true only when every denial was a pure read denial. */
  toScopeRequest(reason = "sub-agent was denied access to files needed for the task"): ScopeRequest | null {
    const all = this.getDenied();
    if (all.length === 0) return null;
    return {
      files: all.map((d) => d.path),
      read_only: !all.some((d) => d.write),
      reason,
    };
  }
}

export function formatScopeRequest(req: ScopeRequest): string {
  return `<scope-request>${JSON.stringify(req)}</scope-request>`;
}

export function parseScopeRequest(text: string | undefined): ScopeRequest | null {
  if (!text) return null;
  const match = text.match(/<scope-request>([\s\S]*?)<\/scope-request>/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed.files) || parsed.files.length === 0) return null;
    return {
      files: parsed.files.map(String),
      read_only: !!parsed.read_only,
      reason: String(parsed.reason || "access denied"),
    };
  } catch {
    return null;
  }
}
