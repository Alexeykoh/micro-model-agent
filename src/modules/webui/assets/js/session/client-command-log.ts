// Journal for client-only slash commands (`/clear`, `/new`).
//
// Both commands are browser-side by design (the server has no feed to clear or
// tab to open), so the composer tells the server about the action only — the
// server logs it and does nothing else (B-35).
import { api } from "../api.js";

export type ClientCommandAction = "clear" | "new";

/** Fire-and-forget notification; a failed log must not block the local action. */
export function logClientCommand(action: ClientCommandAction, sessionId: string | null): void {
  const body: Record<string, unknown> = { action };
  if (sessionId) body.sessionId = sessionId;
  void api("/api/command", { method: "POST", body });
}
