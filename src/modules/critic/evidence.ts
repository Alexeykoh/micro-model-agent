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
}

export interface EvidenceInput {
  task: string;
  planSummary?: string;
  toolEvents: EvidenceToolEvent[];
}

const MAX_DIGEST_LINES = 40;

export function buildEvidencePack(input: EvidenceInput): EvidencePack {
  const changedFiles = new Set<string>();
  const commands: EvidencePack["commands"] = [];
  const digest: string[] = [];
  for (const ev of input.toolEvents) {
    const args = ev.args ? summarizeToolArgs(ev.args) : "";
    digest.push(`${ev.ok === false ? "✗" : "✓"} ${ev.tool} ${args}`.trim());
    if (
      (ev.tool === "write_file" || ev.tool === "edit_file") &&
      typeof ev.args?.path === "string"
    ) {
      changedFiles.add(ev.args.path);
    }
    if (ev.tool === "bash" && typeof ev.args?.command === "string") {
      commands.push({ command: ev.args.command, exitCode: ev.ok === false ? 1 : 0 });
    }
  }
  return {
    task: input.task,
    planSummary: input.planSummary,
    changedFiles: [...changedFiles],
    commands,
    toolDigest: digest.slice(-MAX_DIGEST_LINES).join("\n"),
  };
}
