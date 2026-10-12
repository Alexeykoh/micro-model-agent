/**
 * Сервисный `PromptIO`: интерактивные тулы (`question`/`approve`) спрашивают
 * через SSE-`question`, ответ приходит `POST /v1/tasks/:jobId/answer`.
 *
 * Job-режим prompt-тулы не регистрирует (вопросы запрещены, спека §5.2).
 * Interactive: статус задачи на висящем вопросе → `waiting_input`; резолв
 * возвращает `running` и эмитит `task.started {resumed:true}`.
 */
import type { SessionRunner } from "../../../core/bootstrap/session-runner";
import type { PromptIO } from "../../../tools/prompt-io";
import type { AskChoiceOptions, InputOption } from "../../../tools/user-input";
import { questionTool } from "../../../tools/question";
import { approveTool } from "../../../tools/approve";
import type { AgentServiceState } from "../state";
import { emitEvent } from "./emit";
import type { TaskRecord } from "./task-registry";

let questionSeq = 0;

/** Монотонный id висящего вопроса без коллизий. */
function nextQuestionId(): string {
  questionSeq += 1;
  return `q${Date.now().toString(36)}-${questionSeq}`;
}

/** Приводит ответ клиента к массиву индексов (`-1` = «свой ответ» сохраняется). */
function toIndexes(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    const n = typeof item === "number" ? item : Number(item);
    if (Number.isInteger(n) && n >= -1) out.push(n);
  }
  return out;
}

/** Приводит ответ клиента к строке. */
function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

/** Вешает висящий вопрос, эмитит `question`/`task.waiting_input`, резолвится ответом. */
function ask<T>(
  s: AgentServiceState,
  task: TaskRecord,
  payload: Record<string, unknown>,
  coerce: (value: unknown) => T,
): Promise<T> {
  return new Promise((resolve) => {
    const id = nextQuestionId();
    s.pendingQuestions.set(id, {
      resolve: (value) => resolve(coerce(value)),
      sessionId: task.sessionId,
      taskId: task.jobId,
    });
    s.tasks.update(task.jobId, { status: "waiting_input" });
    emitEvent(s, task, "question", { id, ...payload });
    emitEvent(s, task, "task.waiting_input", { id });
  });
}

/** Сервисный `PromptIO` для конкретной задачи (вопросы тегируются taskId). */
export function servicePromptIO(s: AgentServiceState, task: TaskRecord): PromptIO {
  return {
    askText(question) {
      return ask(s, task, { text: question, kind: "text" }, toText);
    },
    askChoice(question, options: InputOption[], opts: AskChoiceOptions = {}) {
      return ask(
        s,
        task,
        {
          text: question,
          kind: "choice",
          options: options.map((o) => o.label ?? String(o)),
          multiple: !!opts.multiple,
          allowCustom: !!opts.allowCustom,
        },
        toIndexes,
      );
    },
  };
}

/** Регистрирует prompt-тулы в реестре раннера и ставит `PromptIO` (interactive). */
export function installServicePromptIO(
  s: AgentServiceState,
  task: TaskRecord,
  runner: SessionRunner,
): PromptIO {
  for (const tool of [questionTool, approveTool]) {
    if (!runner.registry.has(tool.name)) runner.registry.register(tool, "core");
  }
  const io = servicePromptIO(s, task);
  runner.agent.setPromptIO(io);
  return io;
}

/**
 * Резолвит все висящие вопросы задачи через `undefined` (тул прочтёт пусто/`[]`).
 * Звать при отмене/abort задачи, иначе `agent.run` навсегда ждёт `PromptIO` и
 * слот сессии не освобождается.
 */
export function cancelTaskQuestions(s: AgentServiceState, taskId: string): void {
  const pending: Array<(value: unknown) => void> = [];
  for (const [id, q] of s.pendingQuestions) {
    if (q.taskId === taskId) {
      pending.push(q.resolve);
      s.pendingQuestions.delete(id);
    }
  }
  for (const resolve of pending) resolve(undefined);
}

/** Закрывает висящий вопрос ответом; `false` — id неизвестен. */
export function resolveAnswer(s: AgentServiceState, id: string, value: unknown): boolean {
  const pending = s.pendingQuestions.get(id);
  if (!pending) return false;
  s.pendingQuestions.delete(id);
  pending.resolve(value);
  const rec = pending.taskId ? s.tasks.get(pending.taskId) : undefined;
  if (rec && rec.status === "waiting_input") {
    s.tasks.update(rec.jobId, { status: "running" });
    emitEvent(s, rec, "task.started", { resumed: true });
  }
  return true;
}
