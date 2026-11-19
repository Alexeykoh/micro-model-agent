/**
 * Replay-провайдер: воспроизводит запись сессии как ответы LLM.
 *
 * Нужен для детерминированного replay: тот же `session.jsonl`, что разбирает
 * `mma session diagnose`, становится последовательностью ответов модели. Ни
 * сети, ни API-ключа, ни квантизации — иначе инвариант петли нельзя проверять
 * ни в `bun test`, ни в CI.
 *
 * Провайдер честно повторяет только форму ответа (`tool_calls`/`text`); весь
 * смысл проверки — в инвариантах над реакцией агента, а не в том, что он
 * «поумнеет» от повтора.
 */
import type { Chunk, LLMProvider, Message, ToolDefinition } from "../../src/llm/provider";

/** Один ответ провайдера: текст и/или вызовы тулов. */
export interface ReplayTurn {
  text?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

/** Параметры replay-провайдера. */
export interface ReplayProviderOptions {
  /** Сценарий по номеру хода; последний повторяется, пока ходы не кончатся. */
  turns: ReplayTurn[];
  /** Что повторять вместо исчерпанных ходов (обычно «пустой финал»). */
  fallback?: ReplayTurn;
  /** Принимать ли системный промпт в записи запроса (для проверок инвариантов). */
  onRequest?: (messages: Message[], tools: ToolDefinition[]) => void;
}

/** Провайдер, отдающий заранее заданные ответы по порядку. */
export class ReplayProvider implements LLMProvider {
  readonly model = "replay";
  readonly contextWindow = 32768;
  /** Все запросы, дошедшие до провайдера: инварианты читают их отсюда. */
  readonly requests: Array<{ messages: Message[]; tools: ToolDefinition[] }> = [];

  private index = 0;

  constructor(private readonly options: ReplayProviderOptions) {}

  async *chat(
    messages: Message[],
    tools: ToolDefinition[] = [],
  ): AsyncGenerator<Chunk> {
    this.requests.push({ messages, tools });
    this.options.onRequest?.(messages, tools);
    const turn =
      this.options.turns[this.index] ?? this.options.fallback ?? { text: "" };
    this.index++;
    if (turn.text) yield { type: "text", content: turn.text };
    if (turn.toolCalls?.length) {
      yield {
        type: "tool_call",
        toolCalls: turn.toolCalls.map((c, i) => ({
          id: `call_${this.index}_${i}`,
          name: c.name,
          arguments: c.arguments,
        })),
      };
    }
    yield { type: "done", finishReason: "stop" };
  }

  countTokens(text: string): number {
    // Приближение 4 символа на токен — совпадает с оценщиком контекста,
    // поэтому пороги компакции в replay ведут себя как в бою.
    return Math.ceil(text.length / 4);
  }

  async listModels(): Promise<string[]> {
    return [this.model];
  }

  /** Сколько ответов провайдер уже отдал. */
  get turn(): number {
    return this.index;
  }
}

/**
 * Сценарий-«разгон компакции»: модель на каждом ходу зовёт тул, ничего не
 * накапливая. Контекст не растёт, поэтому давление на компакцию создаётся
 * искусственно через `contextBudget` — иначе инвариант «нет разбега» не на что
 * проверять.
 */
export function compactionStormTurns(count: number): ReplayTurn[] {
  return Array.from({ length: count }, () => ({
    text: "Ещё немного.",
    toolCalls: [{ name: "list_dir", arguments: { path: "." } }],
  }));
}