/**
 * Учёт сообщений контекста: монотонный seq и taint (`file-content`).
 *
 * Вынесено из `ContextManager` (правило 6): менеджер держит историю и бюджеты,
 * а адресация/происхождение записей — здесь. T1–T3 спеки
 * `2026-11-02-local-provider-taint-design.md`.
 */
import { getMessageText } from "../../llm/provider";
import type { ContentPart } from "../../llm/provider";
import {
  FILE_CONTENT_MASK,
  isTaggedFileContent,
} from "../../modules/security/data-policy/file-content";
import type { Message } from "./message";

/** Минимальная форма записи: роль и содержимое. */
export interface TaintableMessage {
  role: string;
  content: unknown;
}

/** Замаскировать tainted-запись для внешней цели (INV-T2). */
export function maskTaintedMessage(msg: Message): Message {
  const masked: Message = { ...msg, content: FILE_CONTENT_MASK };
  if (msg.tool_calls) {
    masked.tool_calls = msg.tool_calls.map((tc) => ({
      ...tc,
      function: { ...tc.function, arguments: FILE_CONTENT_MASK },
    }));
  }
  return masked;
}

/** seq и taint-состояние одной истории. */
export class MessageBookkeeping {
  private next = 0;
  private byMessage = new WeakMap<object, number>();
  private taintedSeqs = new Set<number>();
  private turnHadTaint = false;
  private trusted = false;

  /** Монотонный seq; `-1` — объект не из этой истории. */
  seqOf(msg: object): number {
    return this.byMessage.get(msg) ?? -1;
  }

  /** Проштамповать сообщение и вернуть его же. */
  stamp<T extends object>(msg: T): T {
    this.byMessage.set(msg, this.next++);
    return msg;
  }

  /** Маркер хода: следующий seq. Новый ход сбрасывает наследование taint. */
  beginTurn(): number {
    this.turnHadTaint = false;
    return this.next;
  }

  /** Доверие цели egress: только локальная модель даёт производный taint. */
  setEgressTrusted(trusted: boolean): void {
    this.trusted = trusted;
  }

  /** Помечено ли сообщение как производное от защищённого содержимого. */
  isTainted(msg: object): boolean {
    return this.taintedSeqs.has(this.seqOf(msg));
  }

  /** Индексы tainted-записей, выровненные с историей. */
  taintedIndexes(messages: readonly object[]): boolean[] {
    return messages.map((m) => this.isTainted(m));
  }

  /** Пометить запись по происхождению (T1 — тул с тегом, T2 — производный ответ). */
  note(msg: TaintableMessage): void {
    if (msg.role === "tool" && isTaggedFileContent(getMessageText(msg.content as string | ContentPart[]))) {
      this.taintedSeqs.add(this.seqOf(msg as object));
      this.turnHadTaint = true;
      return;
    }
    if (msg.role === "assistant" && this.turnHadTaint && this.trusted) {
      this.taintedSeqs.add(this.seqOf(msg as object));
    }
  }

  /** Сброс всей истории (clear менеджера). */
  reset(): void {
    this.next = 0;
    this.byMessage = new WeakMap();
    this.taintedSeqs.clear();
    this.turnHadTaint = false;
    this.trusted = false;
  }
}
