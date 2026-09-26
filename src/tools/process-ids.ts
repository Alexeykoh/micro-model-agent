import { processRegistry, type ManagedProcess } from "../modules/processes";
import { t } from "../i18n/index";

/**
 * Shared "no id given" answer for the process_* tools: usage hint plus the
 * currently known ids (or an explicit empty-registry note). One copy —
 * process-kill/process-log/process-wait must not drift apart.
 */
export function missingProcessIdHint(): string {
  const ids = processRegistry.list().map((p) => p.id);
  const listPart = ids.length
    ? `\n${t("proc.list_header")}: ${ids.join(", ")}`
    : `\n${t("proc.missing_id_list")}`;
  return `${t("proc.missing_id")}${listPart}`;
}

export type ProcessLookup =
  | { ok: true; id: string; entry: ManagedProcess }
  | { ok: false; output: string };

/**
 * Shared id validation + registry lookup for the process_* tools. Returns
 * the entry, or `{ ok: false, output }` to return directly as the tool
 * result (missing id → usage hint, unknown id → not-found).
 */
export function lookupProcess(args: Record<string, unknown>): ProcessLookup {
  if (args.id === undefined || String(args.id).trim() === "") {
    return { ok: false, output: missingProcessIdHint() };
  }
  const id = String(args.id);
  const entry = processRegistry.get(id);
  if (!entry) {
    return { ok: false, output: t("proc.not_found", { id }) };
  }
  return { ok: true, id, entry };
}
