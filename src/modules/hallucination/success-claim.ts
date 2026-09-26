/**
 * Success-claim check (ses_muih0ah5): the model announced "MMA 2.8.0
 * published" while its own tool results showed `latest: 2.5.0` and a 404 on
 * the 2.8.0 tarball. Factual-check only validates file paths, so a strong
 * success claim contradicting recent tool evidence passed silently.
 *
 * Purely deterministic (regex + tool success flags, no LLM): a strong
 * completion claim together with error signals in recent tool outputs and
 * no hedging in the answer is a contradiction. Precision is deliberately
 * recall-leaning — a false positive costs one bounded re-check iteration
 * (MAX_CLAIM_CHECK_RETRIES), a false negative is the status quo.
 */

export interface ClaimToolEvidence {
  name?: string;
  ok?: boolean;
  text: string;
}

export interface ClaimContradiction {
  /** Tool/message the contradicting evidence came from. */
  tool: string;
  /** First meaningful line of the contradicting output (capped). */
  snippet: string;
}

/**
 * Word-boundary helper. `\b`/`\w` are ASCII-only in JS, so Cyrillic word
 * endings (опубликован**а**, ошибк**а**) never match them — boundaries are
 * spelled out explicitly for both alphabets. Lookbehind is supported by all
 * runtimes MMA targets (Node ≥20, Bun).
 */
const WORD = "A-Za-zА-Яа-яЁё0-9_";
const wb = (body: string): RegExp =>
  new RegExp(`(?<![${WORD}])(?:${body})(?![${WORD}])`, "i");

/** Strong, unhedged completion claims (any locale the agent speaks). */
const SUCCESS_CLAIM_RE = wb(
  "published|опубликован[а-яё]*|задеплоен[а-яё]*|deployed|shipped|готово|выполнено|завершен[а-яё]*|успешно|success(?:ful(?:ly)?)?|done|completed?|finished|все сделано|всё сделано",
);

/** The answer already hedges — the model accounted for uncertainty. */
const HEDGE_RE = wb(
  "may take|being processed|processing|staged|propagat[a-z]*|in progress|shortly|soon|will appear|несколько минут|обрабатывается|застейджен[а-яё]*|подожд[а-яё]*|проверь[а-яё]* позже|появится|пропагир[а-яё]*|кэш[а-яё]*|cach[a-z]*|обычно|typically",
);

/** Error signals in tool output (kept narrow: codes + explicit failures). */
const FAILURE_SIGNAL_RE = new RegExp(
  `${wb("404|409|40[03]|50\\d|failed|failure|not found|ERR_[A-Z_]+|E(?:404|409|ACCES|PERM|CONNREFUSED|TIMED?OUT)|conflict|denied|ошибка|ошибк[а-яё]*|не найден[а-яё]*|не удалось|отклонено").source}|✗|⛔`,
  "i",
);

const EVIDENCE_WINDOW = 10;
const EVIDENCE_TEXT_CAP = 400;
const SNIPPET_MAX_CHARS = 160;

/**
 * Returns the contradicting evidence, or null when the answer is fine:
 * no success claim, hedged wording, or no error signals in recent tools.
 */
export function checkSuccessClaim(
  response: string,
  tools: ClaimToolEvidence[],
): ClaimContradiction | null {
  if (!response || !SUCCESS_CLAIM_RE.test(response)) return null;
  if (HEDGE_RE.test(response)) return null;
  const recent = tools.filter((t) => t.text?.trim()).slice(-EVIDENCE_WINDOW);
  // Most recent contradiction first — the freshest evidence is quoted.
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
