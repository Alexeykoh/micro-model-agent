import type { AgentModule, AgentPlugin } from "../types";
import type { PromptBlock } from "../../core/types";
import type { SessionManager } from "./manager";
import { t } from "../../i18n/index";

export class SessionModule implements AgentModule {
  name = "session";

  private manager: SessionManager;

  constructor(manager: SessionManager) {
    this.manager = manager;
  }

  getSystemPromptBlock(): PromptBlock | null {
    const meta = this.manager.getActiveMeta();
    if (!meta) return null;
    // Stable per session: id/name/model/contextWindow do not change between
    // turns, so the system prompt is not mutated (KV-cache, rule #10). Live
    // values (message count) are exposed through the session_info tool.
    return {
      content: t("session.info_full", {
        name: meta.name,
        id: meta.id,
        model: meta.model,
        contextWindow: meta.contextWindow,
      }),
      priority: "low",
      essential: false,
      estimatedTokens: 30,
    };
  }

  getPlugin(): AgentPlugin {
    return {
      name: "session",
    };
  }
}
