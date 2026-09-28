// Kill-колбэки долгоживущих тул-хендлеров: экзекутор дёргает их при таймауте/прерывании.
// Сам спавн живёт в `registry.ts`; `runCommand` удалён в пользу behavior-based
// promotion в фон (см. `src/tools/bash.ts`).
interface ActiveChild {
  kill: () => void;
}

const activeChildren = new Map<string, ActiveChild>();

/** Регистрирует kill-колбэк тул-вызова (для таймаута/аборта экзекутора). */
export function registerKillable(callId: string, kill: () => void): void {
  activeChildren.set(callId, { kill });
}

/** Снимает kill-колбэк завершившегося хендлера. */
export function unregisterKillable(callId: string): void {
  activeChildren.delete(callId);
}

/** Вызывает (и снимает) kill-колбэк для `callId`; false — не было. */
export function killByCallId(callId: string): boolean {
  const entry = activeChildren.get(callId);
  if (!entry) return false;
  activeChildren.delete(callId);
  try {
    entry.kill();
  } catch {
    /* уже мёртв */
  }
  return true;
}
