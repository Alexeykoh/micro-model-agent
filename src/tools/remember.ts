
/** Тул записи в межсессионную память (preferences, факты, решения, ошибки). */
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { MemoryStore } from "../modules/memory/store";
import { globalMemoryDir } from "../config/paths";

/** Категории памяти. */
const CATEGORIES = ["preferences", "conventions", "decisions", "errors", "facts"];

/** Пишет факт/преференс в глобальную память. Параметры: category, key/value или entry. */
export const rememberTool: ToolDefinition = {
  name: "remember",
  icon: "🧠",
  description:
    "Remember information across sessions. Use for user preferences, facts, conventions, decisions, or errors.",
  tags: ["memory"],
  parameters: {
    type: "object",
    properties: {
      category: {
        type: "string",
        description: "Memory category: preferences, conventions, decisions, errors, facts",
        enum: CATEGORIES,
      },
      key: {
        type: "string",
        description: 'Key name (required for preferences, e.g. "color", "language")',
      },
      value: {
        type: "string",
        description: "Value to store (required for preferences)",
      },
      entry: {
        type: "string",
        description: "Text entry to append (for conventions, decisions, errors, facts)",
      },
    },
    required: ["category"],
  },
  handler: async (_ctx, args) => {
    const category = String(args.category || "");
    if (!CATEGORIES.includes(category)) {
      return { success: false, output: t("tool.invalid_params") };
    }

    const memoryDir = globalMemoryDir();
    const store = new MemoryStore(memoryDir);

    try {
      if (category === "preferences") {
        const key = String(args.key || "");
        const value = String(args.value || "");
        if (!key) {
          return { success: false, output: t("tool.remember.key_required") };
        }
        store.setPreference(key, value);
        return {
          success: true,
          output: t("tool.remember.preference", { key, value }),
        };
      }

      const entry = String(args.entry || "");
      if (!entry) {
        return { success: false, output: t("tool.remember.entry_required") };
      }
      store.append(category, entry);
      return {
        success: true,
        output: t("tool.remember.entry", { category, entry }),
      };
    } catch (err) {
      // Упавшая запись — провал: отчёт об успехе заставлял агента (и учёт
      // падений) верить, что память сохранена.
      return { success: false, output: t("tool.memory_error", { error: String(err) }) };
    }
  },
};
