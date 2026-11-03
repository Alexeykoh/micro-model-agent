/**
 * Сессионное мемо детерминированных read-only результатов исполнителя.
 * Вынесено из `executor.ts` (правило ≤300); ключ и TTL — контракт
 * `ToolDefinition.cacheable` / `manualMemo` (см. `tests/executor.test.ts`).
 */
import type { ToolCall, ToolResult } from "./types";
import type { RegisteredTool } from "./registry";
import { stableArgsKey } from "./args-key";
import { TOOL_MEMO_TTL_MS as MEMO_TTL_MS } from "../config/timeouts";

const MEMO_MAX_ENTRIES = 100;

type MemoEntry = { result: ToolResult; at: number };

/** Хранилище мемо; `entries` общее у форков исполнителя. */
export class ToolMemo {
  constructor(
    private readonly sessionId: () => string | undefined,
    readonly entries: Map<string, MemoEntry> = new Map(),
  ) {}

  private key(name: string, args: Record<string, unknown>): string {
    return `${this.sessionId() ?? ""}::${name}::${JSON.stringify(stableArgsKey(args))}`;
  }

  /**
   * Чтение мемо для `manualMemo`-тулов (bash). Возвращает откреплённую копию —
   * `toolCallId` вызывающий ставит сам.
   */
  get(name: string, args: Record<string, unknown>): ToolResult | undefined {
    const key = this.key(name, args);
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > MEMO_TTL_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return { ...hit.result };
  }

  /** Запись в мемо для `manualMemo`-тулов. Хранит откреплённую копию. */
  set(name: string, args: Record<string, unknown>, result: ToolResult): void {
    const key = this.key(name, args);
    if (!this.entries.has(key) && this.entries.size >= MEMO_MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { result: { ...result }, at: Date.now() });
  }

  /** Сброс мемо — после всего, что могло мутировать состояние. */
  invalidate(): void {
    this.entries.clear();
  }

  /** Учёт мемо после исполнения (хит не переписывает, мутация сбрасывает). */
  update(
    tool: RegisteredTool,
    call: ToolCall,
    result: ToolResult,
    memoHit: ToolResult | undefined,
  ): void {
    if (memoHit) return;
    // Успешные детерминированные чтения мемоизируются; всё остальное, что
    // реально выполнялось, могло мутировать состояние (даже упавшая команда
    // применяется наполовину) — мемо сбрасывается. `manualMemo` (bash) ведут
    // свои записи сами.
    if (tool.cacheable && result.success) {
      this.set(call.name, call.arguments, result);
    } else if (!tool.cacheable && !tool.manualMemo) {
      this.invalidate();
    }
  }
}
