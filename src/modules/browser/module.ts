// Модуль браузера: системный промпт, тул навигации, закрытие сессии на выходе.
import type { AgentModule, AgentPlugin } from "../types";
import type { PromptBlock } from "../../core/types";
import type { ToolDefinition } from "../../tools/types";
import { createBrowserTool, closeBrowserSession } from "../../tools/browser";

/** Модуль headless-браузера: промпт workflow, тул, плагин закрытия сессии. */
export class BrowserModule implements AgentModule {
  name = "browser";

  getSystemPromptBlock(): PromptBlock | null {
    return {
      content: [
        "You have a headless browser tool. Use it to navigate websites, click links, fill forms, and read page content.",
        "Workflow: open(url) → read snapshot → click/type on element numbers → read updated snapshot.",
        'Each snapshot includes a "Content" section with the visible page text, a "Console" section with browser messages, and network errors. Use these to understand the page, detect JS errors, and verify the result of your actions.',
        'Always start with "open" action. Use element numbers from snapshot for click/type targets.',
        'The "screenshot" action is delivered automatically: a vision model receives the image, a text-only model receives the text snapshot instead. You do not need to decide — just call it and read what you get.',
      ].join("\n"),
      priority: "normal",
      essential: false,
      estimatedTokens: 80,
    };
  }

  getToolDefinitions(): ToolDefinition[] {
    return [createBrowserTool()];
  }

  getPlugin(): AgentPlugin {
    return {
      name: "browser",
      onSessionEnd: () => {
        closeBrowserSession();
      },
    };
  }
}
