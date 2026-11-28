// Модуль браузера: системный промпт, тул навигации, закрытие сессии на выходе.
import type { AgentModule, AgentPlugin } from "../types";
import type { PromptBlock } from "../../core/types";
import type { ToolDefinition } from "../../tools/types";
import { createBrowserTool, closeBrowserSession } from "../../tools/browser";
import { isChromiumInstalled, CHROMIUM_INSTALL_CMD } from "./preflight";

/** Модуль headless-браузера: промпт workflow, тул, плагин закрытия сессии. */
export class BrowserModule implements AgentModule {
  name = "browser";
  /** Результат пробы Chromium из `setup()` (undefined — проба ещё не шла). */
  private chromiumInstalled: boolean | undefined;

  /** Проба Chromium для честного `health()` (вызывается из `ModuleDef.setup`). */
  async probe(): Promise<void> {
    this.chromiumInstalled = await isChromiumInstalled();
  }

  /** Честный health: Chromium не установлен → degraded с командой установки (INV-6). */
  health(): { status: "ok" | "degraded" | "failed"; reason?: string } {
    if (this.chromiumInstalled === undefined) {
      return { status: "degraded", reason: "chromium not probed yet" };
    }
    if (!this.chromiumInstalled) {
      return { status: "degraded", reason: `chromium not installed — run \`${CHROMIUM_INSTALL_CMD}\`` };
    }
    return { status: "ok" };
  }

  getSystemPromptBlock(): PromptBlock | null {
    return {
      content: [
        "The browser tool is active. Use it for JS-rendered pages, clicks and forms.",
        "Follow the browser tool's own workflow and restrictions: snapshots, element numbers, no search-engine queries.",
      ].join("\n"),
      priority: "normal",
      essential: false,
      estimatedTokens: 80,
      // Блок говорит «у тебя есть браузер» — только когда браузер реально
      // виден модели; иначе модуль не рекламирует скрытый тул.
      requiresTags: ["browser"],
    };
  }

  getToolDefinitions(): ToolDefinition[] {
    return [createBrowserTool()];
  }

  getPlugin(): AgentPlugin {
    return {
      name: "browser",
      description: "opens and drives a browser for pages that need JavaScript",
      onSessionEnd: () => {
        closeBrowserSession();
      },
    };
  }
}
