import { homedir } from "os";
import { join } from "path";
import type { AgentModule, AgentPlugin } from "../types";
import type { PromptBlock } from "../../core/types";
import type { ToolDefinition } from "../../tools/types";
import { MemoryStore } from "./store";
import { rememberTool } from "../../tools/remember";
import { recallTool } from "../../tools/recall";

const MEMORY_MD_FILES = ["errors", "conventions", "decisions", "facts"];

export class MemoryModule implements AgentModule {
  name = "memory";
  private store: MemoryStore;

  constructor(storeOrDir?: MemoryStore | string) {
    if (storeOrDir instanceof MemoryStore) {
      this.store = storeOrDir;
    } else {
      const dir = storeOrDir || join(homedir(), ".mma", "memory");
      this.store = new MemoryStore(dir);
    }
  }

  getSystemPromptBlock(): PromptBlock | null {
    const parts: string[] = [];

    const prefs = this.store.getPreferences();
    if (Object.keys(prefs).length > 0) {
      const prefStr = Object.entries(prefs)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      parts.push(`User preferences: ${prefStr}`);
    }

    const memoryTail = this.getMemoryTail();
    if (memoryTail) parts.push(memoryTail);

    if (parts.length === 0) return null;

    const content = parts.join("\n\n");
    return {
      content,
      priority: "normal",
      essential: false,
      estimatedTokens: Math.ceil(content.length / 4) + 10,
    };
  }

  /**
   * Bounded tail of the append-only .md memory files (errors, conventions,
   * decisions, facts). This is what makes past-session lessons visible in the
   * system prompt — without it the loop's error rules are write-only.
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
    // Hard cap so a huge errors.md can never blow the system prompt budget.
    if (joined.length > 1200) joined = joined.slice(0, 1200) + "\n…";
    return joined;
  }

  getToolDefinitions(): ToolDefinition[] {
    return [rememberTool, recallTool];
  }

  getPlugin(): AgentPlugin {
    return {
      name: "memory",
      isBuiltin: true,
      onBuildPrompt: () => {
        const parts: string[] = [];
        const prefs = this.store.getPreferences();
        if (Object.keys(prefs).length > 0) {
          const prefStr = Object.entries(prefs)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ");
          parts.push(`User preferences: ${prefStr}`);
        }
        const memoryTail = this.getMemoryTail();
        if (memoryTail) parts.push(memoryTail);
        return parts.length > 0 ? parts.join("\n\n") : null;
      },
    };
  }

  getStore(): MemoryStore {
    return this.store;
  }
}
