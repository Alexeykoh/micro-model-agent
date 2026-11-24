/** Поверхность журнала правок файлов: единая точка для исполнителя и сессий. */
import type { AppConfig } from "../../config/types";
import type { Diagnostic } from "../../output/types";
import type { FileChangesPort } from "../../tools/types";
import { ChangeCapture } from "./capture";
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
  const undoer = new ChangeUndo({ store, getConfig: deps.getConfig, baseDir: "", log: deps.log });
  // callId → sessionId: нужен только чтобы знать, чью эвикцию запустить после
  // успешного коммита. Не раскрывает pending-снапшоты самого capture.
  const sessions = new Map<string, string>();
  return {
    beginTurn: (sessionId) => { store.nextTurn(sessionId); },
    captureBefore: (ctx, tool, call) => {
      if (ctx.sessionId) sessions.set(call.id, ctx.sessionId);
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
    list: (options) => {
      undoer.setBaseDir(options.baseDir);
      return undoer.list(options);
    },
    undo: (options) => {
      undoer.setBaseDir(options.baseDir);
      return undoer.undo(options);
    },
  };
}
