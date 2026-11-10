import { describe, it, expect } from "vitest";
import { ToolRegistry, registerAllTools } from "../../src/tools/index";
import { DEFAULTS } from "../../src/config/defaults";

/**
 * Дефект E (спека 0.25.2): описание `bash` советовало `process_wait` и другие
 * `process_*`, которые доступны только с тегом `shell` — а он не входит в
 * `defaultTags`. Модель получала совет, который не может выполнить.
 *
 * Гвард: любое имя тула, упомянутое в описании активного (видимого модели)
 * тула, обязано быть доступным в `defaultTags ∪ alwaysOn`.
 */
describe("tool descriptions reference only available tools (E)", () => {
  it("no active tool description names an unavailable tool", () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    const tools = registry.getAll();
    const defaultTags = new Set(DEFAULTS.tools.defaultTags);
    const available = new Set(
      tools
        .filter((t) => t.alwaysOn || (t.tags ?? []).some((tag) => defaultTags.has(tag)))
        .map((t) => t.name),
    );

    const problems: string[] = [];
    for (const tool of tools) {
      if (!available.has(tool.name)) continue; // описание неактивного тула модель не видит
      for (const other of tools) {
        if (available.has(other.name)) continue;
        if (new RegExp(`\\b${other.name}\\b`).test(tool.description)) {
          problems.push(`${tool.name} → ${other.name}`);
        }
      }
    }

    expect(problems, `Описания ссылаются на недоступные тулы:\n${problems.join("\n")}`).toEqual([]);
  });
});
