import { homedir } from "os";
import { join } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { MemoryStore } from "../modules/memory/store";

const CATEGORIES = ["preferences", "conventions", "decisions", "errors", "facts"];

export const recallTool: ToolDefinition = {
  name: "recall",
  icon: "💾",
  description:
    "Recall stored information from memory. Search across preferences, facts, conventions, decisions, errors.",
  tags: ["memory"],
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query (full-text search across all memory)",
      },
      category: {
        type: "string",
        description:
          "Limit to specific category: preferences, conventions, decisions, errors, facts",
        enum: CATEGORIES,
      },
    },
  },
  handler: async (_ctx, args) => {
    const query = args.query ? String(args.query) : "";
    const category = args.category ? String(args.category) : "";
    const memoryDir = join(homedir(), ".mma", "memory");
    const store = new MemoryStore(memoryDir);

    try {
      // No query, no category → show everything
      if (!query && !category) {
        return { success: true, output: formatAll(store) };
      }

      // Category only → show that category
      if (!query && category) {
        return { success: true, output: formatCategory(store, category) };
      }

      // Query with optional category → search
      if (category) {
        const results = searchCategory(store, category, query);
        if (results.length === 0) {
          return { success: true, output: t("tool.recall.empty", { query }) };
        }
        return {
          success: true,
          output: t("tool.recall.search_results", { category, results: results.join("\n") }),
        };
      }

      // Query across all
      const results = store.search(query);
      if (results.length === 0) {
        return { success: true, output: t("tool.recall.empty", { query }) };
      }
      const formatted = results.map((r) => `[${r.file}] ${r.match}`).join("\n");
      return {
        success: true,
        output: t("tool.recall.search_results", { category: "all", results: formatted }),
      };
    } catch (err) {
      return { success: true, output: t("tool.memory_error", { error: String(err) }) };
    }
  },
};

function formatAll(store: MemoryStore): string {
  const parts: string[] = [];

  const prefs = store.getPreferences();
  if (Object.keys(prefs).length > 0) {
    parts.push("Preferences:");
    for (const [k, v] of Object.entries(prefs)) {
      parts.push(`  ${k} = ${v}`);
    }
  }

  for (const cat of ["facts", "conventions", "decisions", "errors"]) {
    const content = store.read(cat);
    const entries = content.split("\n").filter((l) => l.startsWith("- "));
    if (entries.length > 0) {
      parts.push(`\n${cat.charAt(0).toUpperCase() + cat.slice(1)} (last 5):`);
      for (const e of entries.slice(-5)) {
        parts.push(`  ${e}`);
      }
    }
  }

  return parts.length > 0 ? parts.join("\n") : t("tool.recall.no_memory");
}

function formatCategory(store: MemoryStore, category: string): string {
  if (category === "preferences") {
    const prefs = store.getPreferences();
    if (Object.keys(prefs).length === 0) return t("tool.recall.no_memory");
    const lines = ["Preferences:"];
    for (const [k, v] of Object.entries(prefs)) {
      lines.push(`  ${k} = ${v}`);
    }
    return lines.join("\n");
  }

  const content = store.read(category);
  const entries = content.split("\n").filter((l) => l.startsWith("- "));
  if (entries.length === 0) return t("tool.recall.no_memory");
  return `${category.charAt(0).toUpperCase() + category.slice(1)} (${entries.length} entries):\n${entries.join("\n")}`;
}

function searchCategory(store: MemoryStore, category: string, query: string): string[] {
  if (category === "preferences") {
    const prefs = store.getPreferences();
    const lower = query.toLowerCase();
    return Object.entries(prefs)
      .filter(([k, v]) => k.toLowerCase().includes(lower) || v.toLowerCase().includes(lower))
      .map(([k, v]) => `  ${k} = ${v}`);
  }

  const content = store.read(category);
  const lower = query.toLowerCase();
  return content
    .split("\n")
    .filter((l) => l.startsWith("- ") && l.toLowerCase().includes(lower))
    .map((l) => `  ${l}`);
}
