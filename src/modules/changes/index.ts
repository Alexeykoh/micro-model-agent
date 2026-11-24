/** Поверхность журнала правок файлов: единая точка для исполнителя и сессий. */
import type { AppConfig } from "../../config/types";
import type { Diagnostic } from "../../output/types";
import type { FileChangesPort } from "../../tools/types";
import { ChangeCapture, MAX_PENDING, OP_BY_TOOL } from "./capture";
import { ChangesStore } from "./store";
import { ChangeUndo } from "./undo";

export interface PortDeps {
  sessionManager: { getSessionDirectory(id: string): string };
  getConfig: () => AppConfig;
  log?: (detail: Record<string, unknown>) => void;
  onDiagnostic?: (d: Diagnostic) => void;
}

/** Fail-open: дефект эвикции не должен ломать исполнение тула (INV-12/15). */
const evictFailure = (sessionId: string, err: unknown): Diagnostic => ({
  source: "module:changes",
  operation: "changes.evict",
  kind: "failed",
  cause: err instanceof Error ? err.message : String(err),
  recoverable: true,
  detail: { sessionId },
});

export function createFileChangesPort(deps: PortDeps): FileChangesPort {
  const store = new ChangesStore({ sessionManager: deps.sessionManager, getConfig: deps.getConfig });
  const capture = new ChangeCapture(store, deps.getConfig, deps.onDiagnostic);
  const undoFor = (baseDir: string): ChangeUndo =>
    new ChangeUndo({ store, getConfig: deps.getConfig, baseDir, log: deps.log });

  // callId → sessionId только для тулов, у которых capture реально снимает
  // снапшот. Ограничен по размеру, как и pending у самого capture.
  const sessions = new Map<string, string>();
  const remember = (callId: string, sessionId: string): void => {
    if (sessions.has(callId)) sessions.delete(callId);
    else if (sessions.size >= MAX_PENDING) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    sessions.set(callId, sessionId);
  };

  return {
    beginTurn: (sessionId) => { store.nextTurn(sessionId); },
    captureBefore: (ctx, tool, call) => {
      if (
        ctx.sessionId &&
        OP_BY_TOOL[call.name] &&
        deps.getConfig().changes?.enabled !== false
      ) {
        remember(call.id, ctx.sessionId);
      }
      capture.before(ctx, tool, call);
    },
    captureAfter: (callId, success) => {
      const sessionId = sessions.get(callId);
      sessions.delete(callId);
      capture.after(callId, success);
      if (!success || !sessionId) return;
      try {
        store.evict(sessionId);
      } catch (err) {
        deps.onDiagnostic?.(evictFailure(sessionId, err));
      }
    },
    cancel: (callId) => {
      sessions.delete(callId);
      capture.cancel(callId);
    },
    clear: () => {
      sessions.clear();
      capture.clear();
    },
    list: (options) => undoFor(options.baseDir).list(options),
    undo: (options) => undoFor(options.baseDir).undo(options),
  };
}
