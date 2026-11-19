/**
 * Активная сессия демона для thin-клиентов (split W3b/W5): снапшот → первая
 * из списка → новая. Общая для thin-REPL и one-shot.
 */
import type { RemoteHost } from "../modules/daemon/remote-host";

/** Возвращает id сессии и переключает на неё клиент. */
export async function resolveDaemonSession(host: RemoteHost): Promise<string> {
  const state = await host.getState();
  if (state.sessionId) {
    host.setSessionId(state.sessionId);
    return state.sessionId;
  }
  const sessions = await host.listSessions();
  if (sessions[0]) {
    host.setSessionId(sessions[0].id);
    return sessions[0].id;
  }
  const created = await host.createSession("daemon");
  host.setSessionId(created.id);
  return created.id;
}
