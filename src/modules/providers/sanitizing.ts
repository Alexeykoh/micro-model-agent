/**
 * Шов E1: обёртка провайдера, редактирующая egress к модели (спека
 * `2026-10-19-corporate-data-policy-design.md`, §6.2).
 *
 * Регистрация **глобальная** (прецедент `setProviderMemoryApplier`): и активная
 * фабрика (`buildActiveProvider`), и `buildManagedProvider` (критик/эксперт)
 * собирают провайдера через `ProviderManager.build()`, поэтому обёртка в одной
 * точке покрывает оба пути (R17). Слой провайдеров НЕ импортирует security —
 * только структурный контракт guard (INV-3).
 *
 * DEBT(streaming-tail-holdback): `openai-compat` отдаёт аргументы тула одним
 * чанком, поэтому hold-back «хвоста» не нужен; для почанковых провайдеров —
 * отдельная задача.
 */
import type { ChatOptions, Chunk, LLMProvider, Message, ToolDefinition } from "../../llm/provider";

/** Структурный контракт guard'а (реализация — `modules/security/data-policy`). */
export interface ProviderEgressGuard {
  readonly target: { kind: string; trusted: boolean; host?: string };
  sanitizeChat(
    messages: unknown[],
    tools?: unknown[],
  ): { messages: unknown[]; tools?: unknown[]; changed: boolean };
  /** Ре-гидратировать плейсхолдеры в аргументах тула (INV-D5). */
  rehydrateArgs(rawArgs: string): string;
}

/** Запись провайдера, по которой выносится вердикт доверия. */
export interface EgressEntryRef {
  type: string;
  baseUrl: string;
  /** Сессия сборки: журнал DLP маршрутизирует диагностику по ней. */
  sessionId?: string;
}

/** Фабрика guard'а: `undefined` — политика выключена (kill-switch). */
export type EgressGuardFactory = (entry: EgressEntryRef) => ProviderEgressGuard | undefined;

let factory: EgressGuardFactory | null = null;

/** Глобально зарегистрировать фабрику guard (ставит провайдерная фаза bootstrap). */
export function setEgressGuard(next: EgressGuardFactory | null): void {
  factory = next;
}

/** Guard для записи провайдера или `undefined` (нет регистрации/политика off). */
export function getEgressGuard(entry: EgressEntryRef): ProviderEgressGuard | undefined {
  return factory?.(entry);
}

/**
 * Ре-гидратация аргументов тула. Работаем на уровне JSON-значений: токен стоит
 * внутри строки, и подстановка реального Windows-пути в сырой JSON сломала бы
 * экранирование (`C:\work` → `\w`). Не-JSON оставляем как есть.
 */
function rehydrateToolArguments(rawArgs: string, guard: ProviderEgressGuard): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    return rawArgs;
  }
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return guard.rehydrateArgs(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v);
      return out;
    }
    return value;
  };
  return JSON.stringify(walk(parsed));
}

/**
 * Провайдер-обёртка: санитизирует исходящий вызов перед отправкой и
 * ре-гидратирует токены в аргументах тулов из стрима. Семантика стрима
 * (порядок чанков, `done`/`usage`/`warning`, abort) сохраняется 1:1.
 */
export class SanitizingProvider implements LLMProvider {
  constructor(
    private readonly inner: LLMProvider,
    private readonly guard: ProviderEgressGuard,
  ) {}

  get model(): string {
    return this.inner.model;
  }

  get contextWindow(): number {
    return this.inner.contextWindow;
  }

  countTokens(text: string): number {
    return this.inner.countTokens(text);
  }

  listModels(): Promise<string[]> {
    return this.inner.listModels();
  }

  async *chat(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    options?: ChatOptions,
  ): AsyncIterable<Chunk> {
    // Fail-closed: ошибка классификатора бросает EgressBlockedError ДО отправки.
    const sanitized = this.guard.sanitizeChat(messages, tools);
    const safeMessages = sanitized.messages as Message[];
    const safeTools = (sanitized.tools ?? tools) as ToolDefinition[] | undefined;
    for await (const chunk of this.inner.chat(safeMessages, safeTools, signal, options)) {
      if (chunk.type === "tool_call" && chunk.toolCall) {
        yield {
          ...chunk,
          toolCall: {
            ...chunk.toolCall,
            arguments: rehydrateToolArguments(chunk.toolCall.arguments, this.guard),
          },
        };
        continue;
      }
      yield chunk;
    }
  }
}
