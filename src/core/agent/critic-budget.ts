/**
 * Бюджет гейта критика (A15): гонка `verify` с дедлайном и отпечаток входа.
 *
 * Два разных таймера не путаются: `critic.timeoutMs` оборачивает ОДИН
 * провайдерский запрос и обязан быть длиннее провайдерского дедлайна;
 * `critic.budgetMs` ограничивает весь гейт (все проходы) после уже
 * доставленного ответа. Если провайдер игнорирует `signal`, гонка всё равно
 * завершается по бюджету — иначе ход висит, пока не ответит чужой дедлайн.
 */
import type { CriticGateDeps } from "./critic-contract";

/** Итог работы под бюджетом: значение (или null при таймауте/отмене) и время. */
export interface BudgetOutcome<T> {
  value: T | null;
  timedOut: boolean;
  /** Пользователь прервал ход: ждать `work` и писать деградацию нельзя. */
  aborted?: boolean;
  durationMs: number;
}

/**
 * Выполняет `work` под дедлайном `budgetMs`, отменяя его через `signal`.
 *
 * Внешняя отмена (Esc/Ctrl+C, web interrupt) завершает гонку СРАЗУ, а не после
 * бюджета: провайдер/тул, который не слушает signal, иначе держал бы ход до
 * конца бюджета — именно так критик было нельзя остановить.
 * @param work работа, принимающая сигнал отмены
 * @param budgetMs потолок, мс; `undefined`/`0` — без дедлайна (поведение v1)
 * @param outer внешний сигнал сессии (отмена пользователем)
 */
export async function runWithBudget<T>(
  work: (signal: AbortSignal) => Promise<T | null>,
  budgetMs: number | undefined,
  outer?: AbortSignal,
): Promise<BudgetOutcome<T>> {
  const controller = new AbortController();
  const started = Date.now();
  const run = work(controller.signal);
  // Отказ после уже проигранной гонки не должен стать unhandled.
  run.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveAbort: (() => void) | undefined;
  const aborted = new Promise<BudgetOutcome<T>>((resolve) => {
    resolveAbort = () => {
      controller.abort();
      resolve({ value: null, timedOut: false, aborted: true, durationMs: Date.now() - started });
    };
  });
  const onOuterAbort = () => resolveAbort?.();
  outer?.addEventListener("abort", onOuterAbort);
  if (outer?.aborted) onOuterAbort();

  try {
    const runPromise = run.then((value) => ({
      value,
      timedOut: false,
      durationMs: Date.now() - started,
    }));
    if (!budgetMs || budgetMs <= 0) {
      return await Promise.race([runPromise, aborted]);
    }
    const timedOut = new Promise<BudgetOutcome<T>>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ value: null, timedOut: true, durationMs: Date.now() - started });
      }, budgetMs);
    });
    return await Promise.race([runPromise, timedOut, aborted]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * Отпечаток входа проверки: форма тул-событий хода + текст ответа.
 *
 * Нужен, чтобы не платить LLM-вызов за повторную проверку того же самого:
 * «тот же пакет» — это тот же набор событий с теми же длинами вывода и тот же
 * текст ответа (хеш ловит правку при той же длине).
 */
export function packFingerprint(deps: CriticGateDeps): string {
  const answer = deps.answerText ?? "";
  return `${evidenceSignature(deps)}|${answer.length}|${hash32(answer)}`;
}

/**
 * Подпись улик — только тул-события хода, без текста ответа. По ней видно,
 * появилась ли после вердикта новая работа (иначе переписанный текст — не улика).
 */
export function evidenceSignature(deps: CriticGateDeps): string {
  return deps.toolEvents.map((e) => `${e.tool}:${e.ok ? 1 : 0}:${e.output?.length ?? 0}`).join(",");
}

/** Дешёвый 32-битный хеш (FNV-1a): только для сравнения, не для безопасности. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
