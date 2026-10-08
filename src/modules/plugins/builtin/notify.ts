// Встроенный плагин уведомлений: логгирует завершение сессии.
import type { AgentPlugin } from "../../types";
import type { ToolContext } from "../../../tools/types";

/**
 * Встроенный плагин: пишет в лог завершение сессии.
 *
 * `shutdown()` дёргается на КАЖДЫЙ interrupt/shutdown, а в web-режиме —
 * ещё и на каждый оборванный слот. Раньше строка была без id и на уровне
 * `info`, из-за чего один ход давал до 14 неразличимых «Session ended»
 * (наблюдалось в ses_muz7sg1l_0ankgu). Теперь: id сессии в тексте (по
 * существующему ключу `session.ended`) и уровень `debug` — это диагностика
 * жизненного цикла, а не пользовательское событие.
 */
export class NotifyPlugin implements AgentPlugin {
  name = "notify";
  priority = 5;
  isBuiltin = true;

  onSessionEnd(ctx: ToolContext): void {
    const id = ctx.sessionId ?? "?";
    // Optional-call: минимальные/легаси контексты плагинов не обязаны нести
    // полный логгер, и обрыв жизненного цикла из-за лога — хуже шума.
    ctx.logger.debug?.(`Session ended: ${id}`);
  }
}

/** Готовый инстанс для регистрации. */
export const plugin = new NotifyPlugin();
