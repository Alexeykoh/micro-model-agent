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
  mode?: AgentMode;
  /** Макс. токенов для загруженных скилов в system prompt (default: 4000) */
  skillTokenBudget?: number;
  /** Макс. количество скилов в base mode (default: 2, 0 = безлимит) */
  maxSkillsBase?: number;
  /** Макс. количество скилов в pro mode (default: 0 = безлимит) */
  maxSkillsPro?: number;
}

/** Режимы работы агента: fast (без скилов), base (обычный), pro (с grill-me) */
export type AgentMode = 'fast' | 'base' | 'pro';

/** Полная конфигурация приложения */
export interface AppConfig {
  providers: Record<string, ProviderConfig>;
  active: ActiveConfig;
  agent: AgentConfig;
  theme?: string;
}
