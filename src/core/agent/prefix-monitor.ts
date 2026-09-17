// src/core/agent/prefix-monitor
/**
 * Клиентский монитор стабильности префикса промпта.
 *
 * Провайдеры кешируют только совпавший префикс промпта. Даже когда провайдер
 * не сообщает cache-метрики (Ollama, экзотические прокси), агент может сам
 * посчитать, насколько текущий промпт продолжает предыдущий, и — что важнее —
 * ЧТО именно сломало префикс. Это не заменяет провайдерский `cached_tokens`,
 * но работает всегда и не даёт спутать отсутствие данных с промахом кеша.
 */

/** Сегменты промпта в порядке отправки: system → tools → history. */
export interface PromptSnapshot {
  system: string;
  tools: string;
  history: string;
}

export type PrefixCause = "none" | "system" | "tools" | "history" | "volatile" | "unknown";

export interface PrefixDelta {
  prevTokens: number;
  currTokens: number;
  commonPrefixTokens: number;
  /** commonPrefixTokens / currTokens (0 при пустом промпте). */
  stableRatio: number;
  cause: PrefixCause;
}

/** Разделитель сегментов при склейке (провайдер склеивает поля сам). */
const SEP = "\n";

/**
 * Маркеры «волатильного» содержимого. Если расхождение префикса попадает на
 * дату/время/UUID/временный путь — это почти наверняка клиентская ошибка
 * стабильности промпта, а не действие модели.
 */
const VOLATILE_RE =
  /(\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|[A-Za-z]:\\|\\AppData\\|\\Temp\\|\/tmp\/)/;

/** Детерминированная сериализация определений тулов для сравнения префикса. */
export function serializeTools(
  tools: Array<{ name: string; description: string; parameters: unknown }>,
): string {
  return tools
    .map((t) => `${t.name}\u0001${t.description}\u0001${JSON.stringify(t.parameters)}`)
    .join("\u0002");
}

/** Детерминированная сериализация истории сообщений для сравнения префикса. */
export function serializeMessages(
  messages: Array<{ role: string; content: unknown }>,
): string {
  return messages
    .map((m) => `${m.role}\u0001${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
    .join("\u0002");
}

/**
 * Собирает снимок промпта из истории сообщений и определений тулов.
 * Системные сообщения выделяются в отдельный сегмент — они стабильны и
 * ломаются по другим причинам, чем история.
 */
export function buildPromptSnapshot(
  messages: Array<{ role: string; content: unknown }>,
  tools: Array<{ name: string; description: string; parameters: unknown }>,
): PromptSnapshot {
  const system: Array<{ role: string; content: unknown }> = [];
  const rest: Array<{ role: string; content: unknown }> = [];
  for (const m of messages) {
    if (m.role === "system") system.push(m);
    else rest.push(m);
  }
  return {
    system: serializeMessages(system),
    tools: serializeTools(tools),
    history: serializeMessages(rest),
  };
}

/** Склейка сегментов в единую строку с запоминанием границ. */
function frame(s: PromptSnapshot): { full: string; toolsStart: number; historyStart: number } {
  const full = s.system + SEP + s.tools + SEP + s.history;
  const toolsStart = s.system.length + SEP.length;
  const historyStart = toolsStart + s.tools.length + SEP.length;
  return { full, toolsStart, historyStart };
}

/**
 * Считает общий префикс текущего и предыдущего промпта и классифицирует
 * причину расхождения. `countTokens` передаётся вызывающим, чтобы функция
 * оставалась чистой и не тянула токенизатор в горячий путь.
 */
export function diffPrompt(
  prev: PromptSnapshot | undefined,
  curr: PromptSnapshot,
  countTokens: (text: string) => number,
): PrefixDelta {
  const c = frame(curr);
  const currTokens = countTokens(c.full);

  if (!prev) {
    return {
      prevTokens: 0,
      currTokens,
      commonPrefixTokens: 0,
      stableRatio: 0,
      cause: "unknown",
    };
  }

  const p = frame(prev);
  const prevTokens = countTokens(p.full);

  // Общий префикс — посимвольно (нижняя граница токенного префикса).
  const maxCp = Math.min(p.full.length, c.full.length);
  let cp = 0;
  while (cp < maxCp && p.full[cp] === c.full[cp]) cp++;

  const commonPrefixTokens = countTokens(c.full.slice(0, cp));
  const stableRatio = currTokens === 0 ? 0 : Math.min(1, commonPrefixTokens / currTokens);

  // Префикс не сломан: идентично, дописано в хвост или усечено.
  if (cp === maxCp) {
    return { prevTokens, currTokens, commonPrefixTokens, stableRatio, cause: "none" };
  }

  let cause: PrefixCause;
  if (cp >= c.historyStart) cause = "history";
  else if (cp >= c.toolsStart) cause = "tools";
  else cause = "system";

  // Волатильное содержимое у точки расхождения перекрывает сегментную причину.
  const window = (c.full.slice(Math.max(0, cp - 40), cp + 160) +
    p.full.slice(Math.max(0, cp - 40), cp + 160));
  if (VOLATILE_RE.test(window)) cause = "volatile";

  return { prevTokens, currTokens, commonPrefixTokens, stableRatio, cause };
}
