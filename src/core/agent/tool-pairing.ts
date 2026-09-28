/**
 * Позиционная нормализация истории под контракт OpenAI Chat Completions:
 * каждый `assistant` с `tool_calls` обязан быть сразу за которым идёт
 * непрерывный блок `role:"tool"` на КАЖДЫЙ объявленный `tool_call_id`.
 *
 * Строгие OpenAI-совместимые бэкенды (DeepSeek, Kimi/Moonshot, часть
 * OpenRouter-маршрутов) иначе отвечают HTTP 400 «An assistant message with
 * 'tool_calls' must be followed by tool messages responding to each
 * 'tool_call_id'». Официальный OpenAI лояльнее, поэтому дефект проявляется не
 * на всех провайдерах.
 *
 * Новые прогоны не создают такой порядок: сообщения step-gate/auto-advance
 * плана уходят через `pendingMessages` (flush на `onBeforeThink`, уже ПОСЛЕ
 * tool-результатов). Этот проход лечит истории, УЖЕ испорченные (resume,
 * старые session.jsonl, вклинившийся `user`/`assistant`), и подстраховывает
 * веб/foreground-пути: недостающие результаты закрываются стабом
 * `[Result unavailable]`, осиротевшие `tool`-сообщения отбрасываются.
 */
import type { Message } from "../../modules/context/manager";

/** Заглушка результата для незавершённого вызова. */
export const UNRESOLVED_TOOL_RESULT = "[Result unavailable]";

/**
 * Приводит историю к валидному позиционному спариванию `assistant(tool_calls)`
 * → непрерывный `tool`-блок. Не мутирует входные сообщения (кроме безопасного
 * клонирования при merge) — возвращает новый массив.
 * @param messages активная история; @returns нормализованная копия.
 */
export function repairToolCallPairing(messages: Message[]): Message[] {
  const out: Message[] = [];
  let pending: Array<{ id: string; name?: string }> = [];

  // Закрывает незавершённые вызовы стабами, сохраняя их порядок.
  const closePending = (): void => {
    for (const call of pending) {
      out.push({
        role: "tool",
        name: call.name,
        content: UNRESOLVED_TOOL_RESULT,
        tool_call_id: call.id,
        success: false,
        blocked: true,
      });
    }
    pending = [];
  };

  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      const last = out[out.length - 1];
      if (last?.role === "assistant" && last.tool_calls?.length) {
        // Подряд идущие assistant(tool_calls) — слить в один ход: провайдер
        // видит второй assistant до ответов на первый и тоже падает.
        const merged: Message = {
          ...last,
          tool_calls: [...last.tool_calls, ...msg.tool_calls],
        };
        out[out.length - 1] = merged;
        pending = merged.tool_calls!.map((tc) => ({ id: tc.id, name: tc.function.name }));
        continue;
      }
      closePending();
      out.push(msg);
      pending = msg.tool_calls.map((tc) => ({ id: tc.id, name: tc.function.name }));
      continue;
    }

    if (msg.role === "tool" && msg.tool_call_id) {
      if (pending.some((c) => c.id === msg.tool_call_id)) {
        out.push(msg);
        pending = pending.filter((c) => c.id !== msg.tool_call_id);
      }
      // Осиротевший tool (нет объявленного вызова) — отбросить.
      continue;
    }

    // Любая другая роль (user/system/assistant без tool_calls) разрывает блок:
    // незавершённые вызовы закрываем ПЕРЕД ней.
    closePending();
    out.push(msg);
  }

  closePending();
  return out;
}
