import { resolve, normalize } from "path";
import type { ToolScope } from "./types";

export function isPathInScope(
  baseDir: string,
  targetPath: string,
  scope?: ToolScope,
): { allowed: boolean; reason?: string } {
  const baseResolved = resolve(baseDir);
  const targetResolved = resolve(baseDir, normalize(targetPath));

  if (!targetResolved.startsWith(baseResolved)) {
    return { allowed: false, reason: "Path is outside the base working directory" };
  }

  if (!scope) return { allowed: true };

  const isRead = scope.read_only_files.some((f) => targetResolved.startsWith(resolve(baseDir, f)));
  const isWrite = scope.allowed_files.some((f) => targetResolved.startsWith(resolve(baseDir, f)));

  if (isWrite) return { allowed: true };
  if (isRead) return { allowed: true, reason: "Read-only file" };

  return { allowed: false, reason: "Path is not within the allowed scope for this sub-agent" };
}

export function isPathWritable(
  baseDir: string,
  targetPath: string,
  scope?: ToolScope,
): { allowed: boolean; reason?: string } {
  const baseResolved = resolve(baseDir);
  const targetResolved = resolve(baseDir, normalize(targetPath));

  if (!targetResolved.startsWith(baseResolved)) {
    return { allowed: false, reason: "Path is outside the base working directory" };
  }

  if (!scope) return { allowed: true };

  const isWrite = scope.allowed_files.some((f) => targetResolved.startsWith(resolve(baseDir, f)));

  if (isWrite) return { allowed: true };

  return { allowed: false, reason: "Path is not within the writable scope for this sub-agent" };
}
