import type { ModeConfig, ModeContext, ModeBehaviors } from './types.js';

/**
 * Применение конфигурации режима к агенту.
 *
 * Не мутирует state напрямую — возвращает объект с параметрами,
 * которые loop.ts / repl/index.ts применяют к своему state.
 *
 * @module agent/modes/applier
 */

/** Результат применения режима — параметры для агента */
export interface AppliedMode {
  /** Ключ шаблона system prompt */
  systemPromptTemplate: string;
  /** Макс. количество скилов */
  maxSkills: number;
  /** Бюджет токенов для скилов */
  skillTokenBudget: number;
  /** Минимальный контекст */
  minContextWindow: number;
  /** Принудительные скилы */
  forcedSkills: string[];
  /** Разрешить автозагрузку */
  allowAutoLoadSkills: boolean;
  /** Поведения */
  behaviors: ModeBehaviors;
  /** Префикс промпта */
  promptPrefix: string;
  /** Режим для subagent */
  subagentMode: string;
  /** Показывать thinking */
  showThinking: boolean;
  /** Тихий режим */
  quiet: boolean;
}

/**
 * Применяет режим и возвращает параметры.
 *
 * @param config - конфигурация режима
 * @param context - контекст (renderer, quiet, showThinking)
 * @returns параметры для агента
 */
export function applyMode(config: ModeConfig, context?: ModeContext): AppliedMode {
  // Определяем quiet/showThinking из контекста или конфига
  const quiet = context?.quiet ?? config.ui.quiet;
  const showThinking = context?.showThinking ?? config.ui.showThinking;

  // Устанавливаем префикс на renderer
  if (context?.renderer?.setMode) {
    context.renderer.setMode(config.ui.promptPrefix || config.id);
  }

  return {
    systemPromptTemplate: config.systemPromptTemplate,
    maxSkills: config.constraints.maxSkills,
    skillTokenBudget: config.constraints.skillTokenBudget,
    minContextWindow: config.constraints.minContextWindow,
    forcedSkills: config.forcedSkills,
    allowAutoLoadSkills: config.allowAutoLoadSkills,
    behaviors: config.behaviors,
    promptPrefix: config.ui.promptPrefix,
    subagentMode: config.subagentMode,
    showThinking,
    quiet,
  };
}
