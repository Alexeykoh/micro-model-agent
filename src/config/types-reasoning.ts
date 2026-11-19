// Типы reasoning: уровни усилия, стратегия провайдера и политика auto.

/** Уровни reasoning-усилия, совместимые с opencode + OpenAI API + llama.cpp chat_template_caps. */
export type ReasoningLevel = "default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Как провайдер выражает reasoning-усилие в запросе API.
 * - "openai-effort": поле `reasoning_effort` в теле (OpenAI, OpenRouter, vLLM);
 * - "template-kwarg": бэкенд-специфичное поле тела (llama.cpp `chat_template_kwargs`);
 * - "prompt-tag": тег в конце последнего user-сообщения (`/no_think` для Qwen);
 * - "none": не поддерживается — фича выключена.
 */
export type ReasoningStrategy = "openai-effort" | "template-kwarg" | "prompt-tag" | "none";

/** Режим: "auto" — динамическое управление политикой; прочее — фикс. уровень. */
export type ReasoningMode = ReasoningLevel | "auto";

export interface ReasoningConfig {
  /** Активный режим. "auto" — политика харнесса крутит уровень по итерациям. */
  mode: ReasoningMode;
  /** Минимум в auto-режиме (нижний кламп). */
  min: Exclude<ReasoningLevel, "default" | "auto">;
  /** Максимум в auto-режиме (верхний кламп). */
  max: Exclude<ReasoningLevel, "default" | "auto">;
  /** Мин. итераций между оверрайд-вызовами агента. */
  overrideCooldown: number;
  /**
   * Стартовый уровень auto-политики до сигналов итераций (итерация 1 и тихие
   * итерации). Без значения — фолбэк на `min` ("low" в `DEFAULTS`): тривиальные
   * Q&A-ходы больше не платят "medium"; политика всё равно поднимает до high
   * на галлюцинациях / отклонениях аудита / создании плана.
   */
  baseline?: Exclude<ReasoningLevel, "default" | "auto">;
}
