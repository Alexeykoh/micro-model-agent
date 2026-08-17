import type { AgentPlugin } from "../../types";
import type { ToolContext } from "../../../tools/types";

export class NotifyPlugin implements AgentPlugin {
  name = "notify";
  priority = 5;
  isBuiltin = true;

  onSessionEnd(ctx: ToolContext): void {
    ctx.logger.info("Session ended");
  }
}

export const plugin = new NotifyPlugin();
