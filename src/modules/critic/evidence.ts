import { readFileSync } from "fs";
import { resolve } from "path";
import type { EvidencePack } from "./types";
import { summarizeToolArgs } from "../../core/agent/tool-output";

const MUTATING_TOOLS = new Set(["write_file", "edit_file", "delete_file", "move_file", "create_dir"]);

/** Work mutation = filesystem-changing tool (bash counts; plan/todo bookkeeping does not). */
export function isWorkMutation(name: string): boolean {
  return MUTATING_TOOLS.has(name) || name === "bash";
}

export interface EvidenceToolEvent {
  tool: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  /** Tail of the tool result output (already budget-truncated upstream). */
  output?: string;
}

export interface EvidenceInput {
  task: string;
  planSummary?: string;
  toolEvents: EvidenceToolEvent[];
  /** Workspace root — when provided, changed files are read back (bounded excerpts) so the critic verifies content, not just paths. */
  baseDir?: string;
}

const MAX_DIGEST_LINES = 40;
/** Output tail attached to bash/failed digest lines (test/build results are the verification signal). */
const MAX_DIGEST_OUTPUT_CHARS = 300;
const MAX_EXCERPT_FILES = 5;
const MAX_EXCERPT_CHARS = 1200;

export function buildEvidencePack(input: EvidenceInput): EvidencePack {
  const changedFiles = new Set<string>();
  const commands: EvidencePack["commands"] = [];
  const digest: string[] = [];
  for (const ev of input.toolEvents) {
    digest.push(digestLine(ev));
    const file = changedFileOf(ev);
    if (file) changedFiles.add(file);
    const cmd = commandOf(ev);
    if (cmd) commands.push(cmd);
  }
  return {
    task: input.task,
    planSummary: input.planSummary,
    changedFiles: [...changedFiles],
    commands,
    toolDigest: digest.slice(-MAX_DIGEST_LINES).join("\n"),
    fileExcerpts: input.baseDir ? readExcerpts(input.baseDir, [...changedFiles]) : undefined,
  };
}

/** One digest line per event. Bash output (test/build results) and any failure
 *  output travel with the line — otherwise the critic judges success blind. */
function digestLine(ev: EvidenceToolEvent): string {
  const args = ev.args ? summarizeToolArgs(ev.args) : "";
  const line = `${ev.ok === false ? "✗" : "✓"} ${ev.tool} ${args}`.trim();
  if (ev.output && (ev.tool === "bash" || ev.ok === false)) {
    return `${line} » ${ev.output.slice(-MAX_DIGEST_OUTPUT_CHARS)}`;
  }
  return line;
}

/** Workspace-relative path of a file a write/edit event touched. */
function changedFileOf(ev: EvidenceToolEvent): string | undefined {
  if (ev.tool !== "write_file" && ev.tool !== "edit_file") return undefined;
  return typeof ev.args?.path === "string" ? ev.args.path : undefined;
}

/** Bash event as a critic-visible command record (with bounded output tail). */
function commandOf(ev: EvidenceToolEvent): EvidencePack["commands"][number] | undefined {
  if (ev.tool !== "bash" || typeof ev.args?.command !== "string") return undefined;
  return {
    command: ev.args.command,
    exitCode: ev.ok === false ? 1 : 0,
    output: ev.output?.slice(-MAX_DIGEST_OUTPUT_CHARS),
  };
}

/** Best-effort bounded head excerpts of changed files. Unreadable (deleted, binary, outside root) → skipped, never throws. */
function readExcerpts(baseDir: string, paths: string[]): Array<{ path: string; excerpt: string }> {
  const out: Array<{ path: string; excerpt: string }> = [];
  const root = resolve(baseDir);
  for (const p of paths.slice(0, MAX_EXCERPT_FILES)) {
    try {
      const abs = resolve(root, p);
      if (abs !== root && !abs.startsWith(`${root}/`) && !abs.startsWith(`${root}\\`)) continue;
      const text = readFileSync(abs, "utf-8");
      out.push({ path: p, excerpt: text.slice(0, MAX_EXCERPT_CHARS) });
    } catch {
      // Unreadable (deleted, binary, outside root) — skipped silently.
    }
  }
  return out;
}
