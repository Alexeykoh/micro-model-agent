// Браузерный `PromptIO` для `mma web`: вопросы через SSE, ответы через `POST /api/answer`.
/**
 * Интерактивные тулы (`question`/`approve`) зовут `askText`/`askChoice`; вместо
 * терминала регистрируют висящий резолвер в shared `WebUiState`, бродкастят
 * SSE-событие `question` и закрываются ответом браузера через `POST /api/answer`
 * (см. `answer-api.ts`). Правило #11: интерактив идёт через ту же поверхность
 * `PromptIO` — отличается только транспорт.
 */
import type { PromptIO } from "../../tools/prompt-io";
import type { InputOption, AskChoiceOptions } from "../../tools/user-input";
import type { ToolDefinition } from "../../tools/types";
import { questionTool } from "../../tools/question";
import { approveTool } from "../../tools/approve";
import { broadcast, type WebUiState } from "./state";

let questionSeq = 0;

/** Монотонный id висящего вопроса без коллизий. */
function nextQuestionId(): string {
  questionSeq += 1;
  return `q${Date.now().toString(36)}-${questionSeq}`;
}

/**
 * Приводит произвольный пейлоад браузера к массиву индексов для `askChoice`.
 * `-1` ({@link CUSTOM_INDEX}) сохраняется: метка пункта «свой ответ»,
 * который тул затем дорезолвит follow-up вызовом `askText`.
 */
function toIndexes(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    const n = typeof item === "number" ? item : Number(item);
    if (Number.isInteger(n) && n >= -1) out.push(n);
  }
  return out;
}

/** Приводит произвольный пейлоад браузера к строке для `askText`. */
function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

/** Висящий вопрос: резолвер ответа + сессия-владелец (для scoped cancel). */
export interface PendingQuestion {
  resolve: (value: unknown) => void;
  /** Сессия-владелец; undefined — legacy (main-раннер без фабрики). */
  sessionId?: string;
}

/** Регистрирует висящий вопрос, бродкастит его, резолвится приведённым ответом. */
function ask<T>(
  state: WebUiState,
  payload: Record<string, unknown>,
  coerce: (value: unknown) => T,
  sessionId?: string,
): Promise<T> {
  return new Promise((resolve) => {
    const id = nextQuestionId();
    state.pendingQuestions.set(id, { resolve: (value) => resolve(coerce(value)), sessionId });
    broadcast({ type: "question", ts: Date.now(), id, ...(sessionId ? { sessionId } : {}), ...payload }, state);
  });
}

/**
 * Браузерный `PromptIO`: спрашивает через SSE, закрывается в `resolveAnswer`.
 * С `sessionId` вопрос тегируется сессией-владельцем: параллельные ходы
 * кладут карточку в правильную вкладку, interrupt чистит только свои.
 */
export function createWebPromptIO(state: WebUiState, sessionId?: string): PromptIO {
  return {
    askText(question) {
      return ask(state, { text: question, kind: "text" }, toText, sessionId);
    },
    askChoice(question, options: InputOption[], opts: AskChoiceOptions = {}) {
      return ask(
        state,
        {
          text: question,
          kind: "choice",
          options: options.map((o) => o.label ?? String(o)),
          multiple: !!opts.multiple,
          allowCustom: !!opts.allowCustom,
        },
        toIndexes,
        sessionId,
      );
    },
  };
}

/** Закрывает висящий вопрос по id. False — id неизвестен. */
export function resolveAnswer(state: WebUiState, id: string, value: unknown): boolean {
  const pending = state.pendingQuestions.get(id);
  if (!pending) return false;
  state.pendingQuestions.delete(id);
  pending.resolve(value);
  return true;
}

/**
 * Закрывает висящие вопросы через `undefined` (тулы прочтут пусто/`[]`).
 * Звать на interrupt/shutdown, чтобы заблокированный `question`/`approve`
 * не держал ход после того, как браузер перестал отвечать.
 * Без sessionId — все (legacy); со строкой — только вопросы этой сессии
 * (плюс нетегированные legacy — fail-safe от вечного виса); с null —
 * только нетегированные (legacy-слот в фабричном режиме не трогает чужие).
 */
export function cancelPendingQuestions(state: WebUiState, sessionId?: string | null): void {
  const pending: Array<(value: unknown) => void> = [];
  for (const [id, q] of state.pendingQuestions) {
    if (sessionId === undefined) {
      pending.push(q.resolve);
      state.pendingQuestions.delete(id);
    } else if (sessionId === null) {
      if (q.sessionId == null) {
        pending.push(q.resolve);
        state.pendingQuestions.delete(id);
      }
    } else if (q.sessionId === sessionId || q.sessionId == null) {
      pending.push(q.resolve);
      state.pendingQuestions.delete(id);
    }
  }
  for (const resolve of pending) resolve(undefined);
}

/** Минимальная поверхность агента для инсталлера (без импорта `Agent`). */
export interface PromptIOAgent {
  setPromptIO(io?: PromptIO): void;
}

/** Минимальная поверхность реестра (без импорта `ToolRegistry`). */
export interface PromptIORegistry {
  has(name: string): boolean;
  register(tool: ToolDefinition): void;
}

/**
 * Веб-онли wiring: регистрирует интерактивные тулы, снимает `exitOnComplete`
 * с shared тул-контекста (веб-ходы интерактивны, не one-shot — иначе
 * `question`/`approve` коротко замыкаются) и ставит браузерный `PromptIO`.
 * Терминал сюда не ходит, его поведение не меняется.
 */
export function installWebPromptIO(deps: {
  state: WebUiState;
  agent: PromptIOAgent;
  registry?: PromptIORegistry;
  toolCtx?: { exitOnComplete?: boolean };
  /** Сессия-владелец вопросов (параллельные раннеры тегируют свои). */
  sessionId?: string;
}): PromptIO {
  if (deps.registry) {
    for (const tool of [questionTool, approveTool]) {
      if (!deps.registry.has(tool.name)) deps.registry.register(tool);
    }
  }
  if (deps.toolCtx) deps.toolCtx.exitOnComplete = false;
  const io = createWebPromptIO(deps.state, deps.sessionId);
  deps.agent.setPromptIO(io);
  return io;
}
