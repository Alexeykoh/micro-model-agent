/**
 * Circuit breaker для MCP-вызовов: два подряд неудачных вызова на сервер
 * закрывают его на фиксированный cooldown. Сессия ses_mwt1gw9o_eyxsehbrwjrhdzsn
 * делала 6 переоткрытий страницы через сломанный Playwright MCP, хотя уже
 * работал web_fetch; без предохранителя модель тратит минуты на сбойный тул.
 */
/** Сколько подряд неудач закрывает сервер. */
export const MCP_FAILURE_THRESHOLD = 2;
/** Как долго сервер считается закрытым, мс. */
export const MCP_COOLDOWN_MS = 60_000;

const failures = new Map<string, number>();
const blockedUntil = new Map<string, number>();

/** Закрыт ли сервер сейчас; истёкший cooldown снимается. */
export function mcpCircuitBlocked(server: string, now: number = Date.now()): boolean {
  const until = blockedUntil.get(server);
  if (until === undefined) return false;
  if (now >= until) {
    blockedUntil.delete(server);
    failures.set(server, 0);
    return false;
  }
  return true;
}

/** Учесть неудачу; true — именно этот вызов открыл circuit. */
export function recordMcpFailure(server: string, now: number = Date.now()): boolean {
  const count = (failures.get(server) ?? 0) + 1;
  failures.set(server, count);
  if (count >= MCP_FAILURE_THRESHOLD) {
    blockedUntil.set(server, now + MCP_COOLDOWN_MS);
    return true;
  }
  return false;
}

/** Успех сбрасывает серию и снимает блокировку. */
export function recordMcpSuccess(server: string): void {
  failures.set(server, 0);
  blockedUntil.delete(server);
}

/** Тестовый крючок: обнулить состояние между прогонами. */
export function resetMcpCircuitForTests(): void {
  failures.clear();
  blockedUntil.clear();
}
