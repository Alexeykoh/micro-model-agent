/**
 * Единая классификация транзиентных (временно сбойных) ошибок.
 *
 * Ранее существовало ДВЕ расходящиеся копии: `TRANSIENT_PATTERNS` в
 * stuck-detector.ts и `TRANSIENT_ERROR_PATTERNS` во втором исполнителе,
 * снятом 2026-10-12. Из-за этого одна и та же ошибка по-разному
 * ретраилась в разных подсистемах: снятый исполнитель считал транзиентными
 * 500/504/"network"/"fetch failed", stuck-detector — "killed"/"SIGTERM"/
 * "rate limit" и т.д.
 *
 * Здесь — объединение обеих копий в единый источник истины, чтобы решение
 * "эту ошибку можно ретраить" было одинаковым во всей системе.
 */
const TRANSIENT_PATTERNS: RegExp[] = [
  /timeout/i,
  /timed out/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /killed/i,
  /SIGTERM/i,
  /SIGKILL/i,
  /rate limit/i,
  /\b(429|500|502|503|504)\b/,
  /network/i,
  /fetch failed/i,
  // Ошибки провайдера, пришедшие ПОСЛЕ старта генерации. Раньше сюда не
  // попадали: сообщение «Provider returned an error mid-stream: …» не матчит
  // ни один паттерн выше, поэтому обрыв стрима считался нетранзиентным и
  // задача падала с первой попытки без backoff.
  /mid-stream/i,
  /error mid.stream/i,
  // Локальный однодвижковый бэкенд (LM Studio/llama.cpp): параллельные
  // запросы к одной модели роняют загрузку движка. Причина инфраструктурная и
  // транзиентная — повтор после backoff проходит.
  /engine protocol/i,
  /failed to load model/i,
  /unable to load model/i,
  /model load/i,
  /engine startup/i,
  // Зависший/оборванный стрим: контента нет, повтор запроса оправдан.
  /stream stalled/i,
  /stream (?:closed|ended)/i,
  /no data for \d+ms/i,
  /socket hang ?up/i,
  /context (?:length|window) (?:exceeded|exhausted)/i,
  /too many concurrent/i,
  /server (?:is )?(?:busy|overloaded)/i,
];

/** Истинно, если сообщение похоже на транзиентную (временно сбойную) ошибку. */
export function isTransientError(message: string): boolean {
  return TRANSIENT_PATTERNS.some((p) => p.test(message));
}

/**
 * Инфраструктурная ошибка провайдера: сбой транспорта/бэкенда, а не провал
 * содержания задачи. По ней нельзя делать re-plan — перепланирование не
 * чинит ни движок, ни сеть, оно только жжёт бюджет (наблюдалось: оба сабтаска
 * упали по mid-stream обрыву, а re-plan повторил то же самое ещё раз).
 */
const INFRA_PATTERNS: RegExp[] = [
  /mid-stream/i,
  /error mid.stream/i,
  /LLM API error/i,
  /engine protocol/i,
  /(?:failed|unable) to load model/i,
  /engine startup/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /fetch failed/i,
  /socket hang ?up/i,
  /stream (?:stalled|closed|ended)/i,
  /no data for \d+ms/i,
  /context (?:length|window) (?:exceeded|exhausted)/i,
  /too many concurrent/i,
  /server (?:is )?(?:busy|overloaded)/i,
  /\b(?:429|500|502|503|504)\b/,
];

/**
 * Классифицирует ошибку сабтаска: инфраструктурная (провайдер/транспорт) или
 * контентная (задача не выполнена). Потребители решают по ней, ретраить или
 * перепланировать: re-plan — только для контентных фейлов.
 * @param message текст ошибки сабтаска (error/summary).
 * @returns true, если ошибка инфраструктурная.
 */
export function isInfraError(message: string): boolean {
  return INFRA_PATTERNS.some((p) => p.test(message));
}
