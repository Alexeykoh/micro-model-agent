/**
 * Константы агентного цикла. Вынесены из agent.ts, чтобы:
 * 1) не растекаться магическими числами по модулям;
 * 2) быть переиспользуемыми между extracted-модулями (compaction, tool-batch и т.д.);
 * 3) каждая константа несёт JSDoc с обоснованием значения.
 */

/** Макс. доля бюджета истории под результат одного тула (по токенам). */
export const TOOL_RESULT_MAX_TOKENS_RATIO = 0.3;
/** Абсолютный потолок результата тула в символах. */
export const TOOL_RESULT_ABSOLUTE_MAX_CHARS = 15000;
/**
 * Порог качества контекста, ниже которого включается принудительная
 * компакция. См. FORCED_COMPACTION_COOLDOWN — без cooldown низкое
 * качество ретриггерит компакцию на каждой итерации.
 */
export const QUALITY_TRIGGER_THRESHOLD = 40;
/**
 * Макс. символов аргументов тула в <system-summary>. Не допускает
 * дублирования `content` из write_file поверх role:"tool" сообщения,
 * которое уже несёт результат.
 */
export const TOOL_ARGS_SUMMARY_MAX_CHARS = 240;
/**
 * Мин. число итераций между принудительными компакциями по качеству.
 * Без него компакция не может восстановить качество и выжигает весь
 * бюджет на компактирование (наблюдалось: 56 компакций за ~28 минут).
 */
export const FORCED_COMPACTION_COOLDOWN = 3;
/** Макс. повторов при восстановимой ошибке LLM (например, токен-лимит). */
export const MAX_LLM_ERROR_RETRIES = 2;
/** Макс. повторов при вердикте халлюцинации "retry". */
export const MAX_HALLUCINATION_RETRIES = 3;
/** Порог подряд идущих неудач тулов до сообщения о восстановлении. */
export const MAX_CONSECUTIVE_TOOL_FAILURES = 5;
/**
 * Мин. общих (не подряд идущих) неудач тула до записи правила в память.
 * Фиксирует системные проблемы (ENOENT у LSP, сломанный конфиг), которые
 * не всплывают по пути "5 подряд неудач".
 */
export const MIN_REPEATED_TOOL_FAILURES = 3;
/** Макс. повторов финального аудита. */
export const MAX_AUDIT_RETRIES = 3;
/** Макс. повторов пустого ответа. */
export const MAX_EMPTY_RESPONSE_RETRIES = 2;
/** Макс. повторных одинаковых тулов в режиме exit-on-complete. */
export const MAX_REPEATED_TOOL_CALLS = 2;