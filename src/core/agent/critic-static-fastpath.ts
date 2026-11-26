/** BCP-6: дешёвый путь критика для статических файловых ходов. */
import type { CriticGateDeps } from "./critic-contract";

/** Тулы, чья успешная работа подтверждается статически. */
const STATIC_FILE_TOOLS = new Set([
  "read_file", "write_file", "append_file", "edit_file", "patch_file",
  "file_info", "glob", "grep", "list_dir",
]);

/** Минимум два файловых действия и никаких behavioral-сигналов. */
export function isStaticFileTurn(deps: CriticGateDeps): boolean {
  if (deps.planPendingSteps && deps.planPendingSteps.length > 0) return false;
  if (deps.toolEvents.length < 2) return false;
  return deps.toolEvents.every((e) => e.ok !== false && STATIC_FILE_TOOLS.has(e.tool));
}
