// Session journal for slash commands run from `mma web` (B-35).
//
// Until now `/export`, `/clear`, `/new` and the rest left no trace in
// `session.jsonl`: a command was visible only in the live SSE feed. One record
// per command keeps the answer to "what did the user run and what came back?"
// next to the turn it affected.
import type { SessionLogEntry } from "../../session/store";
import { redactContextSecrets } from "../../../core/api";
import type { SessionStore } from "../state";

/** Cap for command/result text in the journal (diagnostics, not a transcript). */
const MAX_TEXT = 600;

/** Client-only commands accepted by `POST /api/command` (`{ action }`). */
export const CLIENT_COMMAND_LINES: Record<string, string> = {
  clear: "/clear",
  new: "/new",
};

function redact(text: string): string {
  return redactContextSecrets(text).slice(0, MAX_TEXT);
}

/**
 * Append one `command` record: line, source, success/failure and short result.
 * Fail-open: a journal failure must not break the command path.
 */
export function appendCommandLog(
  state: Pick<SessionStore, "sessionManager">,
  line: string,
  success: boolean,
  result: string | string[],
  sessionId?: string,
): void {
  const manager = state.sessionManager;
  if (!manager) return;
  const text = Array.isArray(result) ? result.join("\n") : result;
  const entry: SessionLogEntry = {
    ts: new Date().toISOString(),
    type: "command",
    source: "module:webui",
    module: "webui",
    content: redact(line),
    status: success ? "ok" : "error",
    success,
    message: redact(text),
  };
  try {
    // Client-only commands carry the tab's own session id. When that session
    // is not active (background tab, another turn running), write there rather
    // than into the active session's journal.
    if (sessionId && manager.get(sessionId)) manager.appendLog?.(entry, sessionId);
    else manager.appendLog?.(entry);
  } catch {
    /* fail-open: journal must not fail the command */
  }
}
