/**
 * Проверка заявлений об успехе (ses_muih0ah5): модель объявила "MMA 2.8.0
 * опубликован", а её же тулы показывали `latest: 2.5.0` и 404 на тарболле
 * 2.8.0. Factual-check валидирует только пути файлов, так что сильное
 * заявление об успехе вразрез со свежими доказательствами прошло молча.
 *
 * Полностью детерминирована (regex + флаги успеха тулов, без LLM): сильное
 * заявление о завершении + сигналы ошибок в свежих выводах тулов + отсутствие
 * хеджирования в ответе = противоречие. Точность осознанно смещена в recall —
 * ложное срабатывание стоит одну ограниченную re-check итерацию
 * (MAX_CLAIM_CHECK_RETRIES), пропуск — статус-кво.
 */

/** Доказательство из тула: имя, успех, текст вывода. */
export interface ClaimToolEvidence {
  name?: string;
  ok?: boolean;
  text: string;
}

/** Противоречие: откуда доказательство + первая значимая строка вывода (с капом). */
export interface ClaimContradiction {
  /** Тул/сообщение — источник противоречащего доказательства. */
  tool: string;
  /** Первая значимая строка противоречащего вывода (с капом). */
  snippet: string;
}

/**
 * Помощник границ слов. `\b`/`\w` в JS — только ASCII, поэтому кириллические
 * окончания (опубликован**а**, ошибк**а**) их не матчат — границы выписаны явно
 * для обоих алфавитов. Lookbehind поддерживают все рантаймы MMA (Node ≥20, Bun).
 */
const WORD = "A-Za-zА-Яа-яЁё0-9_";
const wb = (body: string): RegExp =>
  new RegExp(`(?<![${WORD}])(?:${body})(?![${WORD}])`, "i");

/** Сильные, нехеджированные заявления о завершении (любая локаль агента). */
const SUCCESS_CLAIM_RE = wb(
  "published|опубликован[а-яё]*|задеплоен[а-яё]*|deployed|shipped|готово|выполнено|завершен[а-яё]*|успешно|success(?:ful(?:ly)?)?|done|completed?|finished|все сделано|всё сделано",
);

/** Ответ уже хеджирован — модель учла неопределённость, пропускаем. */
const HEDGE_RE = wb(
  "may take|being processed|processing|staged|propagat[a-z]*|in progress|shortly|soon|will appear|несколько минут|обрабатывается|застейджен[а-яё]*|подожд[а-яё]*|проверь[а-яё]* позже|появится|пропагир[а-яё]*|кэш[а-яё]*|cach[a-z]*|обычно|typically",
);

/** Сигналы ошибок в выводе тулов (узко: коды + явные фейлы). */
const FAILURE_SIGNAL_RE = new RegExp(
  `${wb("404|409|40[03]|50\\d|failed|failure|not found|ERR_[A-Z_]+|E(?:404|409|ACCES|PERM|CONNREFUSED|TIMED?OUT)|conflict|denied|ошибка|ошибк[а-яё]*|не найден[а-яё]*|не удалось|отклонено").source}|✗|⛔`,
  "i",
);

const EVIDENCE_WINDOW = 10;
const EVIDENCE_TEXT_CAP = 400;
const SNIPPET_MAX_CHARS = 160;

/**
 * Тулы-блокнот агента: их фейлы — про механику плана (валидация checks,
 * покрытие шагов), а не про исход задачи; целостность плана полисит финальный
 * аудит, а не claim-check. Учитывать их здесь — значит ветировать честное
 * «тесты прошли» из-за stale-ошибки `re-plan` (ses_mupgenhq_75f66l: «Длина
 * checks должна совпадать с числом шагов» против реально прошедших тестов).
 */
const BOOKKEEPING_TOOLS = new Set(["plan", "plan_step", "todo"]);

/**
 * Возвращает противоречащее доказательство, или null если ответ в порядке:
 * нет заявления об успехе, есть хеджирование, или нет сигналов ошибок в свежих тулах.
 */
export function checkSuccessClaim(
  response: string,
  tools: ClaimToolEvidence[],
): ClaimContradiction | null {
  if (!response || !SUCCESS_CLAIM_RE.test(response)) return null;
  if (HEDGE_RE.test(response)) return null;
  const recent = tools
    .filter((t) => t.text?.trim() && !BOOKKEEPING_TOOLS.has(t.name ?? ""))
    .slice(-EVIDENCE_WINDOW);
  // Свежайшее противоречие первым — цитируется самое актуальное доказательство.
  for (let i = recent.length - 1; i >= 0; i--) {
    const entry = recent[i];
    const text = entry.text.slice(0, EVIDENCE_TEXT_CAP);
    if (entry.ok === false || FAILURE_SIGNAL_RE.test(text)) {
      const firstLine = text
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (!firstLine) continue;
      return {
        tool: entry.name || "tool",
        snippet:
          firstLine.length > SNIPPET_MAX_CHARS
            ? `${firstLine.slice(0, SNIPPET_MAX_CHARS - 1)}…`
            : firstLine,
      };
    }
  }
  return null;
}
