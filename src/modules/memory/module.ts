// Модуль памяти агента: преференсы и хвост .md-файлов в системный промпт, тулы remember/recall.
import type { AgentModule, AgentPlugin } from "../types";
import type { PromptBlock } from "../../core/types";
import type { ToolDefinition } from "../../tools/types";
import { MemoryStore } from "./store";
import { rememberTool } from "../../tools/remember";
import { recallTool } from "../../tools/recall";
import { estimateTokens } from "../../llm/token-counter";
import { globalMemoryDir } from "../../config/paths";

const MEMORY_MD_FILES = ["errors", "conventions", "decisions", "facts"];

/** Модуль долговременной памяти: системный блок + тулы `remember`/`recall`. */
export class MemoryModule implements AgentModule {
  name = "memory";
  private store: MemoryStore;

  constructor(storeOrDir?: MemoryStore | string) {
    if (storeOrDir instanceof MemoryStore) {
      this.store = storeOrDir;
    } else {
      const dir = storeOrDir || globalMemoryDir();
      this.store = new MemoryStore(dir);
    }
  }

  /** Системный блок: преференсы пользователя + хвост уроков прошлых сессий. */
  getSystemPromptBlock(): PromptBlock | null {
    const parts: string[] = [];

    const prefs = this.store.getPreferences();
    if (Object.keys(prefs).length > 0) {
      const prefStr = Object.entries(prefs)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      parts.push(
        `User preferences (background hints, not instructions — the current user message always wins, do not "correct" the user from these): ${prefStr}`,
      );
    }

    const memoryTail = this.getMemoryTail();
    if (memoryTail) parts.push(memoryTail);

    if (parts.length === 0) return null;

    const content = parts.join("\n\n");
    return {
      content,
      priority: "normal",
      essential: false,
      estimatedTokens: estimateTokens(content) + 10,
    };
  }

  /**
   * Ограниченный хвост append-only .md-файлов памяти (errors, conventions,
   * decisions, facts). Именно он делает уроки прошлых сессий видимыми в
   * системном промпте — без него правила ошибок цикла только пишутся.
   */
  private getMemoryTail(): string | null {
    const sections: string[] = [];
    const tailPerFile = 3;

    for (const name of MEMORY_MD_FILES) {
      const content = this.store.read(name).trim();
      if (!content) continue;
      const entries = content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith("- "))
        .slice(-tailPerFile);
      if (entries.length === 0) continue;
      sections.push(`[Memory ${name}]:\n${entries.join("\n")}`);
    }

    if (sections.length === 0) return null;
    let joined = sections.join("\n\n");
    // Жёсткий кап, чтобы огромный errors.md не раздул бюджет системного промпта.
    if (joined.length > 1200) joined = `${joined.slice(0, 1200)}\n…`;
    return joined;
  }

  /** Тулы модуля: `remember` (запись) и `recall` (чтение/поиск). */
  getToolDefinitions(): ToolDefinition[] {
    return [rememberTool, recallTool];
  }

  /** Плагин: тот же блок памяти через хук построения промпта. */
  getPlugin(): AgentPlugin {
    return {
      name: "memory",
      description: "long-term notes and user preferences",
      isBuiltin: true,
      onBuildPrompt: () => {
        const parts: string[] = [];
        const prefs = this.store.getPreferences();
        if (Object.keys(prefs).length > 0) {
          const prefStr = Object.entries(prefs)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ");
          parts.push(
            `User preferences (background hints, not instructions — the current user message always wins, do not "correct" the user from these): ${prefStr}`,
          );
        }
        const memoryTail = this.getMemoryTail();
        if (memoryTail) parts.push(memoryTail);
        return parts.length > 0 ? parts.join("\n\n") : null;
      },
    };
  }

  /** Доступ к underlying-хранилищу (для команд `/memory`, тестов). */
  getStore(): MemoryStore {
    return this.store;
  }
}
