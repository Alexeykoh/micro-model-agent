import type { MoEPlan, MoESubtask } from "./types";
import type { AppConfig } from "../../config/types";
import { normalizeInputFrom } from "./input-from";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  autoFixes: Array<{ subtaskId: string; fix: string }>;
}

export function validatePlan(plan: MoEPlan, config: AppConfig): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const autoFixes: Array<{ subtaskId: string; fix: string }> = [];

  if (!plan.subtasks || plan.subtasks.length === 0) {
    return { valid: false, errors: ["Plan has no subtasks"], warnings: [], autoFixes: [] };
  }

  errors.push(...expertTagsExist(plan.subtasks, config));
  errors.push(...hasCycle(plan.subtasks));

  const overlapErrors = hasAllowedFilesOverlap(plan.subtasks);
  errors.push(...overlapErrors);

  const readOverlaps = deleteReadOverlap(plan.subtasks);
  for (const overlap of readOverlaps) {
    if (overlap.canAutoFix) {
      autoFixes.push({ subtaskId: overlap.subtaskId, fix: `Add depends_on: ${overlap.dependsOn}` });
    } else if (overlap.error) {
      errors.push(overlap.error);
    }
  }

  const inputRefErrors = validateInputFromRefs(plan.subtasks);
  errors.push(...inputRefErrors.errors);
  autoFixes.push(...inputRefErrors.autoFixes);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    autoFixes,
  };
}

/**
 * Every input_from reference must point at an existing subtask and be backed
 * by a depends_on edge — otherwise the reader may run before its producer.
 */
export function validateInputFromRefs(subtasks: MoESubtask[]): {
  errors: string[];
  autoFixes: Array<{ subtaskId: string; fix: string }>;
} {
  const errors: string[] = [];
  const autoFixes: Array<{ subtaskId: string; fix: string }> = [];
  const ids = new Set(subtasks.map((s) => s.id));

  for (const s of subtasks) {
    for (const ref of normalizeInputFrom(s.input_from)) {
      if (!ids.has(ref.subtaskId)) {
        errors.push(
          `Subtask "${s.id}" input_from references unknown subtask "${ref.subtaskId}". Known subtasks: ${Array.from(ids).join(", ")}`,
        );
      } else if (!s.depends_on?.includes(ref.subtaskId)) {
        autoFixes.push({ subtaskId: s.id, fix: `Add depends_on: ${ref.subtaskId}` });
      }
    }
  }

  return { errors, autoFixes };
}

export function expertTagsExist(subtasks: MoESubtask[], config: AppConfig): string[] {
  const errors: string[] = [];
  const knownExperts = new Set(Object.keys(config.experts || {}));

  for (const subtask of subtasks) {
    if (!knownExperts.has(subtask.expert_tag)) {
      errors.push(
        `Subtask "${subtask.id}" references unknown expert_tag "${subtask.expert_tag}". Known experts: ${Array.from(knownExperts).join(", ")}`,
      );
    }
  }

  return errors;
}

export function hasCycle(subtasks: MoESubtask[]): string[] {
  const edges = new Map<string, string[]>();
  for (const s of subtasks) {
    edges.set(s.id, s.depends_on || []);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string): boolean {
    if (inStack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    inStack.add(node);
    const deps = edges.get(node) || [];
    for (const dep of deps) {
      if (edges.has(dep) && dfs(dep)) return true;
    }
    inStack.delete(node);
    return false;
  }

  const errors: string[] = [];
  for (const s of subtasks) {
    visited.clear();
    inStack.clear();
    if (dfs(s.id)) {
      errors.push(`Cycle detected involving subtask "${s.id}"`);
      break;
    }
  }

  return errors;
}

export function hasAllowedFilesOverlap(subtasks: MoESubtask[]): string[] {
  const errors: string[] = [];
  const writeFiles = new Map<string, string[]>();

  for (const s of subtasks) {
    for (const f of s.allowed_files || []) {
      if (!writeFiles.has(f)) {
        writeFiles.set(f, []);
      }
      writeFiles.get(f)!.push(s.id);
    }
  }

  for (const [file, writers] of writeFiles) {
    if (writers.length > 1) {
      const noDep = writers.filter((w) => {
        const sub = subtasks.find((s) => s.id === w);
        return sub && !sub.depends_on?.some((d) => writers.includes(d));
      });
      if (noDep.length > 1) {
        errors.push(
          `Write-write overlap on "${file}" between subtasks: ${writers.join(", ")} without dependency chain`,
        );
      }
    }
  }

  return errors;
}

export interface ReadOverlapResult {
  subtaskId: string;
  dependsOn: string;
  canAutoFix: boolean;
  error?: string;
}

/** Two path specs overlap when equal or one is a directory ancestor of the other. */
function pathsOverlap(a: string, b: string): boolean {
  const na = a.replace(/\\/g, "/").replace(/\/+$/, "");
  const nb = b.replace(/\\/g, "/").replace(/\/+$/, "");
  if (na === nb) return true;
  return na.startsWith(nb + "/") || nb.startsWith(na + "/");
}

export function deleteReadOverlap(subtasks: MoESubtask[]): ReadOverlapResult[] {
  const results: ReadOverlapResult[] = [];

  for (let i = 0; i < subtasks.length; i++) {
    for (let j = 0; j < subtasks.length; j++) {
      if (i === j) continue;

      const writer = subtasks[i];
      const reader = subtasks[j];

      if (!writer.allowed_files || !reader.read_only_files) continue;

      const readFiles = new Set(reader.read_only_files);
      const writeFiles = writer.allowed_files;

      // Exact path or a real directory ancestor — NOT a string prefix, which
      // flagged siblings like `src/main.ts` (writer) vs `src/main.tsx` (reader).
      const overlapping = writeFiles.filter((f) =>
        [...readFiles].some((rf) => pathsOverlap(f, rf)),
      );

      if (overlapping.length > 0 && !reader.depends_on?.includes(writer.id)) {
        const canAutoFix = !reader.depends_on || reader.depends_on.length === 0;
        if (canAutoFix) {
          results.push({
            subtaskId: reader.id,
            dependsOn: writer.id,
            canAutoFix: true,
          });
        } else {
          results.push({
            subtaskId: reader.id,
            dependsOn: writer.id,
            canAutoFix: false,
            error: `Read-after-write overlap between "${writer.id}" (writer) and "${reader.id}" (reader) on "${overlapping.join(", ")}" — add depends_on: [${writer.id}]`,
          });
        }
      }
    }
  }

  return results;
}

export function applyAutoFixes(
  plan: MoEPlan,
  autoFixes: Array<{ subtaskId: string; fix: string }>,
): MoEPlan {
  // Deep-ish clone: copy each `depends_on` array so the pushes below never
  // mutate the caller's plan (shallow `{...s}` shared the array).
  const fixed = {
    ...plan,
    subtasks: plan.subtasks.map((s) => ({
      ...s,
      depends_on: [...(s.depends_on ?? [])],
    })),
  };

  for (const fix of autoFixes) {
    const sub = fixed.subtasks.find((s) => s.id === fix.subtaskId);
    if (!sub) continue;

    const dependsOnMatch = fix.fix.match(/depends_on:\s*(\S+)/);
    if (dependsOnMatch) {
      const dep = dependsOnMatch[1];
      if (!sub.depends_on) sub.depends_on = [];
      if (!sub.depends_on.includes(dep)) {
        sub.depends_on.push(dep);
      }
    }
  }

  return fixed;
}
