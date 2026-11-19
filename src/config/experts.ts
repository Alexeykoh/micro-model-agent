// Эксперты: доступ к конфигу эксперта по тегу и валидация tool_tags.
import type { AppConfig, ExpertConfig } from "./types";

/** Конфиг эксперта по тегу. Нет такого — undefined. */
export function getExpertConfig(config: AppConfig, tag: string): ExpertConfig | undefined {
  return config.experts?.[tag];
}

/** Проверяет tool_tags всех экспертов против известных тегов. Возвращает список ошибок. */
export function validateExpertConfig(config: AppConfig, allToolTags: string[]): string[] {
  const errors: string[] = [];
  const knownTags = new Set(allToolTags);

  for (const [name, expert] of Object.entries(config.experts || {})) {
    for (const tag of expert.tool_tags) {
      if (!knownTags.has(tag)) {
        errors.push(
          `Expert "${name}" references unknown tool_tag "${tag}". Known tags: ${Array.from(knownTags).join(", ")}`,
        );
      }
    }
  }

  return errors;
}
