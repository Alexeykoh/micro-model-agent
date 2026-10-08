/**
 * Валидация `experts[tag].model` против моделей активного провайдера.
 *
 * Наблюдалось (живая сессия `ses_muz7sg1l_0ankgu`): в `config/moe.json` у всех
 * экспертов стояла `qwen/qwen3.5-9b`, а активная модель агента — другая
 * (`qwen3.8-9b-distill` на том же LM Studio). `resolveExpertProvider` честно
 * строил выделенный провайдер, но бэкенд такой модели не знает: каждый сабтаск
 * получал `Failed to load model … Engine protocol startup was aborted`, три
 * попытки на сабтаск, и ход умирал молча — ни warn, ни preflight.
 *
 * Здесь — дешёвая проверка по списку моделей провайдера (`/models`): неизвестная
 * модель эксперта заменяется на активную (fail-open, ход продолжается) и
 * пишется в лог. Список недоступен — проверка пропускается (fail-open).
 */
import type { AppConfig } from "../../config/types";

/** Результат проверки: чем заменить модель эксперта + предупреждения. */
export interface ExpertModelCheck {
  /** tag → модель (может совпадать с исходной). */
  models: Record<string, string>;
  /** tag → причина замены (только для реально заменённых). */
  replaced: Record<string, string>;
}

/**
 * Проверяет модели экспертов против списка моделей провайдера.
 * @param config жив���й конфиг (только читается).
 * @param availableModels список моделей провайдера; `null`/`[]` — неизвестно,
 *   проверка пропускается (fail-open).
 * @returns карту моделей и карту замен с причинами.
 */
export function checkExpertModels(
  config: AppConfig,
  availableModels: readonly string[] | null | undefined,
): ExpertModelCheck {
  const models: Record<string, string> = {};
  const replaced: Record<string, string> = {};
  const experts = config.experts ?? {};
  for (const [tag, expert] of Object.entries(experts)) {
    const model = expert?.model?.trim() ?? "";
    models[tag] = model;
  }
  if (!availableModels || availableModels.length === 0) return { models, replaced };

  const known = new Set(availableModels.map((m) => m.trim()).filter(Boolean));
  if (known.size === 0) return { models, replaced };

  for (const [tag, model] of Object.entries(models)) {
    if (!model || model === config.model) continue;
    if (known.has(model)) continue;
    const fallback = config.model;
    models[tag] = fallback;
    replaced[tag] = model;
  }
  return { models, replaced };
}

/**
 * Применяет результат проверки к конфигу для исполнителя MoE: копия конфига с
 * исправленными моделями экспертов. Оригинальный живой конфиг НЕ мутируется —
 * пользователь должен увидеть свою (возможно неверную) настройку в `/config`
 * и в логе, а не молчаливое подмену.
 * @param config исходный конфиг.
 * @param check результат `checkExpertModels`.
 * @returns конфиг для MoE (тот же объект, если замен не было).
 */
export function applyExpertModelCheck(config: AppConfig, check: ExpertModelCheck): AppConfig {
  const tags = Object.keys(check.replaced);
  if (tags.length === 0) return config;
  const experts = { ...(config.experts ?? {}) };
  for (const tag of tags) {
    const expert = experts[tag];
    if (!expert) continue;
    experts[tag] = { ...expert, model: check.models[tag] };
  }
  return { ...config, experts };
}

/** Человекочитаемое предупреждение о замене (одна строка на тег). */
export function describeExpertModelReplacement(
  replaced: Record<string, string>,
  activeModel: string,
  available: readonly string[],
): string {
  return Object.entries(replaced)
    .map(([tag, model]) =>
      `expert "${tag}": model "${model}" is not available on the active provider — using "${activeModel}" (provider models: ${available
        .slice(0, 10)
        .join(", ")}${available.length > 10 ? ", …" : ""})`,
    )
    .join("; ");
}
