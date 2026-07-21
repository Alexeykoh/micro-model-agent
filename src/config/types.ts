/**
 * Типы конфигурации приложения.
 *
 * Определяют структуру конфигов:
 * - Провайдеры и модели
 * - Активная конфигурация
 * - Параметры агента
 * - Режимы работы (fast/base/pro)
 *
 * @module config/types
 */

/** Конфигурация модели */
export interface ModelConfig {
  model: string;
  contextWindow: number;
  params: ModelParams;
}

/** Параметры генерации модели */
export interface ModelParams {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number | null;
  [key: string]: unknown;
}

/** Конфигурация провайдера LLM */
export interface ProviderConfig {
  type: string;
  url: string;
  apiKey: string | null;
  models: Record<string, ModelConfig>;
}

/** Активная конфигурация (провайдер + модель) */
export interface ActiveConfig {
  provider: string;
  model: string;
}

/** Параметры агента */
export interface AgentConfig {
  maxSteps: number;
  autoCompact: boolean;
  compactThreshold: number;
  toolTimeout: number;
  maxOutputLength: number;
  showThinking?: boolean;
  /** @deprecated Используйте ModeRegistry вместо этого */
  mode?: AgentMode;
  /** Макс. токенов для загруженных скилов в system prompt (default: 4000) */
  skillTokenBudget?: number;
  /** @deprecated Используйте ModeRegistry.maxSkills вместо этого */
  maxSkillsBase?: number;
  /** @deprecated Используйте ModeRegistry.maxSkills вместо этого */
  maxSkillsPro?: number;
  /** Параметры LLM: retry, thinking, max_tokens */
  llm?: LLMConfig;
  /** Auto-specialist конфигурация */
  specialist?: SpecialistConfig;
  /** Список плагинов для активации (имена через запятую) */
  plugins?: string[];
}

/** Параметры LLM для tuning (пустые значения = использовать defaults) */
export interface LLMConfig {
  /** Количество повторных попыток при пустом ответе (default: 1) */
  retries?: number;
  /** Retry без thinking при пустом ответе с reasoning chunks (default: true) */
  retryWithoutThinking?: boolean;
  /** Fallback: использовать reasoning как content при пустом ответе (default: true) */
  fallbackToReasoning?: boolean;
  /** max_tokens для reasoning-моделей (default: 32768) */
  maxTokensReasoning?: number;
  /** max_tokens для обычных моделей (default: 4096) */
  maxTokensDefault?: number;
  /** max_tokens после tool call в subagent (default: 24576) */
  maxTokensAfterTool?: number;
  /** Мин. количество reasoning chunks для триггера retry (default: 10) */
  emptyResponseThreshold?: number;
  /** Модель для tool execution в subagent (default: undefined = тот же模型) */
  toolModel?: string;
}

/** Конфигурация auto-specialist (автоделегирование при повторяющихся ошибках) */
export interface SpecialistConfig {
  /** Включить auto-specialist (default: true) */
  enabled?: boolean;
  /** Кол-во одинаковых ошибок до триггера (default: 2) */
  triggerThreshold?: number;
  /** Макс. ходов specialist'а (default: 10) */
  maxSteps?: number;
  /** Мин. длина текста ошибки для триггера — отсекает trivia (default: 15) */
  minErrorLength?: number;
}

/** Режимы работы агента: fast (без скилов), base (обычный), pro (с grill-me) */
export type AgentMode = 'fast' | 'base' | 'pro';

/** Полная конфигурация приложения */
export interface AppConfig {
  providers: Record<string, ProviderConfig>;
  active: ActiveConfig;
  agent: AgentConfig;
  theme?: string;
  /** Кастомные режимы (overrides для ModeRegistry) */
  modes?: Record<string, Record<string, unknown>>;
}
