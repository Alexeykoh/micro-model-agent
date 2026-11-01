/**
 * Хинт GUI о том, как редактировать значение ключа `list`/`json`.
 *
 * Вынесено из `registry.ts` (правило 6: файл на потолке). Реестр остаётся
 * единственным источником правды о ТОМ, что хранит ключ; здесь лишь подсказка
 * показа (строка через запятую годится для `tools.defaultTags`, но неверна для
 * regex с запятыми). Без значения — plain-input (list) или JSON-textarea (json).
 */
export interface ConfigEditorSpec {
  /**
   * `tags` — чипсы строк; `checkboxes` — мультивыбор; `table` — строки записей;
   * `select` — выпадающий список, наполняемый из живого источника
   * (`optionsSource`), а не из статического `enumValues`.
   */
  kind: "tags" | "checkboxes" | "table" | "select";
  /** Живой источник опций для `select` (модели/провайдеры из `/api`). */
  optionsSource?: "models" | "providers";
  /** Допустимые значения для `checkboxes`. */
  options?: readonly string[];
  /** Колонки для `table`. Первая колонка — ключ записи. */
  columns?: ReadonlyArray<{
    key: string;
    /** `number` — числовой инпут, `bool` — чекбокс. Дефолт: текст. */
    type?: "string" | "number" | "bool";
    optional?: boolean;
    /** Текстовая колонка со значением-списком (правится через запятую). */
    array?: boolean;
    /** Колонка-`select`, наполняемая из живого источника опций. */
    optionsSource?: "models" | "providers";
    /**
     * Для `optionsSource: "models"` — ключ колонки, чьё значение выбирает
     * список моделей (напр. `provider`). Пусто — модели активного провайдера.
     */
    dependsOn?: string;
    /** Ключи колонок этой же строки, которые сбрасываются при смене значения. */
    resets?: readonly string[];
    /** i18n-ключ подписи пустого пункта (напр. «как у агента»). */
    emptyLabelKey?: string;
  }>;
  /** Свободный хинт в добавлялке строк (напр. пример regex). */
  placeholder?: string;
}
