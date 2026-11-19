/**
 * Буфер финального черновика (`ui.draftMode: "after-review"`).
 *
 * По умолчанию текст стримится в UI сразу (`live`). В режиме `after-review`
 * чанки копятся здесь, пока гейты (hallucination → critic → audit) не примут
 * ответ: на отказе буфер выбрасывается без `retract`, на accept — отдаётся
 * одним куском. Промежуточная нарация перед вызовом тулов сбрасывается сразу,
 * иначе пользователь видел бы пустой ход во время работы инструментов.
 */
export type DraftMode = "live" | "after-review";

export interface DraftSink {
  /** Текст LLM: в `live` уходит сразу, в `after-review` копится. */
  onText?: (chunk: string) => void;
  /** Показать накопленное (нарация перед тулами / принятый финальный ответ). */
  flush(): void;
  /** Выбросить накопленное (гейт отклонил кандидата). */
  discard(): void;
}

/** Создаёт буфер; `live` — прозрачная обёртка над `onChunk`. */
export function createDraftSink(
  onChunk: ((chunk: string) => void) | undefined,
  mode: DraftMode | undefined,
): DraftSink {
  if (mode !== "after-review") {
    return {
      onText: onChunk,
      flush: () => {},
      discard: () => {},
    };
  }
  let chunks: string[] = [];
  return {
    onText: onChunk
      ? (chunk) => {
          chunks.push(chunk);
        }
      : undefined,
    flush: () => {
      const text = chunks.join("");
      chunks = [];
      if (text) onChunk?.(text);
    },
    discard: () => {
      chunks = [];
    },
  };
}
