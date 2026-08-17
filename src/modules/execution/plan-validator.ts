import type { MoEPlan, MoESubtask } from "./types";
import type { AppConfig } from "../../config/types";

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

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    autoFixes,
  };
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

      const overlapping = writeFiles.filter((f) => {
        for (const rf of readFiles) {
          if (f.startsWith(rf) || rf.startsWith(f)) return true;
        }
        return false;
      });

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
  const fixed = { ...plan, subtasks: plan.subtasks.map((s) => ({ ...s })) };

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
