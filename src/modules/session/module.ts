// Модуль сессии: стабильный системный блок (id/имя/модель/окно) + плагин-заглушка.
// Блок модельный — английский, чтобы не смешивать языки в системном промпте.
import type { AgentModule, AgentPlugin } from "../types";
import type { PromptBlock } from "../../core/types";
import type { SessionManager } from "./manager";

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
      content:
        `[Session: "${meta.name}" (${meta.id}) | model: ${meta.model} | ` +
        `context: ${meta.contextWindow} tokens]`,
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
