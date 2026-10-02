// Kill-колбэки долгоживущих тул-хендлеров: экзекутор дёргает их при таймауте/прерывании.
// Сам спавн живёт в `registry.ts`; `runCommand` удалён в пользу behavior-based
// promotion в фон (см. `src/tools/bash.ts`).
interface ActiveChild {
  kill: () => void;
}

const activeChildren = new Map<string, ActiveChild>();

/**
 * Ключ реестра: сессионный, иначе два параллельных раннера с совпавшим
 * LLM-`callId` затирали бы kill-колбэки друг друга (аборт одной сессии убивал
 * бы процесс другой). Без `sessionId` — legacy-ключ по `callId`.
 */
function killKey(callId: string, sessionId?: string): string {
  return sessionId ? `${sessionId}\u0000${callId}` : callId;
}

/** Регистрирует kill-колбэк тул-вызова (для таймаута/аборта экзекутора). */
export function registerKillable(callId: string, kill: () => void, sessionId?: string): void {
  activeChildren.set(killKey(callId, sessionId), { kill });
}

/** Снимает kill-колбэк завершившегося хендлера. */
export function unregisterKillable(callId: string, sessionId?: string): void {
  activeChildren.delete(killKey(callId, sessionId));
}

/** Вызывает (и снимает) kill-колбэк для `callId`; false — не было. */
export function killByCallId(callId: string, sessionId?: string): boolean {
  const key = killKey(callId, sessionId);
  const entry = activeChildren.get(key);
  if (!entry) return false;
  activeChildren.delete(key);
  try {
    entry.kill();
  } catch {
    /* уже мёртв */
  }
  return true;
}
