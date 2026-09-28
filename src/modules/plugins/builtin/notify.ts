// Встроенный плагин уведомлений: логгирует завершение сессии.
import type { AgentPlugin } from "../../types";
import type { ToolContext } from "../../../tools/types";

/** Встроенный плагин: пишет в лог завершение сессии. */
export class NotifyPlugin implements AgentPlugin {
  name = "notify";
  priority = 5;
  isBuiltin = true;

  onSessionEnd(ctx: ToolContext): void {
    ctx.logger.info("Session ended");
  }
}

/** Готовый инстанс для регистрации. */
export const plugin = new NotifyPlugin();
