import type { MoESubtask, SubtaskResult } from "./types";

export interface InputFromRef {
  subtaskId: string;
  field?: string;
}

/**
 * Accept both compact (`["task-1"]`) and detailed
 * (`[{"subtaskId": "task-1", "field": "json"}]`) forms of input_from.
 */
export function normalizeInputFrom(input: unknown): InputFromRef[] {
  if (!Array.isArray(input)) return [];
  const refs: InputFromRef[] = [];
  for (const entry of input) {
    if (typeof entry === "string") {
      refs.push({ subtaskId: entry });
    } else if (entry && typeof entry === "object" && typeof (entry as any).subtaskId === "string") {
      refs.push({ subtaskId: (entry as any).subtaskId, field: (entry as any).field });
    }
  }
  return refs;
}

function truncate(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= cap) return flat;
  return `${flat.slice(0, cap)}…`;
}

/**
 * Render the "Input from previous tasks" section injected into a dependent
 * subtask's prompt. Failed dependencies are marked explicitly so the reader
 * cannot build logic on missing data.
 */
export function buildInputSection(
  subtask: MoESubtask,
  depResults: Map<string, SubtaskResult>,
  maxChars: number,
): string {
  const refs = normalizeInputFrom(subtask.input_from);
  if (refs.length === 0) return "";

  const lines = refs.map((ref) => {
    const dep = depResults.get(ref.subtaskId);
    if (!dep) {
      return `- ${ref.subtaskId}: (no result available)`;
    }
    const label = ref.field ? `${ref.subtaskId}.${ref.field}` : ref.subtaskId;
    if (!dep.success) {
      return `- ${label}: [FAILED] ${truncate(dep.error || dep.summary || "unknown error", maxChars)}`;
    }
    return `- ${label}: ${truncate(dep.result || dep.summary, maxChars)}`;
  });

  return `\n\nInput from previous tasks:\n${lines.join("\n")}`;
}
