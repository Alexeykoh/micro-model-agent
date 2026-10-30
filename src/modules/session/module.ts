// Модуль сессии: стабильный системный блок (id/имя/модель/окно) + плагин-заглушка.
import type { AgentModule, AgentPlugin } from "../types";
import type { PromptBlock } from "../../core/types";
import type { SessionManager } from "./manager";
import { t } from "../../i18n/index";

/** Модуль сессии: системный блок со стабильными полями + пустой плагин. */
export class SessionModule implements AgentModule {
  name = "session";

  private manager: SessionManager;

  constructor(manager: SessionManager) {
    this.manager = manager;
  }

  getSystemPromptBlock(): PromptBlock | null {
    const meta = this.manager.getActiveMeta();
    if (!meta) return null;
    // Стабильно на сессию: id/имя/модель/окно между ходами не меняются,
    // так что системный промпт не мутирует (KV-кеш). Живое (счётчик сообщений)
    // отдаётся через тул session_info.
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
      description: "session lifecycle and transcript logging",
    };
  }
}
