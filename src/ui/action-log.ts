/**
 * Remember the most recent tool action so the user can reprint its full detail
 * on demand (`Ctrl+O`) even after the run's Renderer is gone.
 *
 * Only the last action is kept — this is a convenience buffer, not a log. The
 * authoritative transcript lives in the session log.
 */
export interface LastAction {
  /** Tool id — used to color the reprint with the category accent. */
  tool: string;
  label: string;
  args: string;
  status: "ok" | "warn" | "error";
  durationMs: number;
  /** Full body lines (paths, diff, output) captured regardless of verbosity. */
  body: string[];
}

let last: LastAction | null = null;

export function recordLastAction(action: LastAction): void {
  last = action;
}

export function getLastAction(): LastAction | null {
  return last;
}

export function clearLastAction(): void {
  last = null;
}
