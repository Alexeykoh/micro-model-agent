/**
 * Browser-backed `PromptIO` for `mma web`.
 *
 * Interactive tools (`question`/`approve`) call `askText`/`askChoice`; instead of
 * borrowing a terminal they register a pending resolver on the shared
 * `WebUiState`, broadcast a `question` SSE event, and settle when the browser
 * answers via `POST /api/answer` (see `answer-api.ts`). Rule #11: interactive
 * tools keep going through the same `PromptIO` surface — only the transport
 * differs.
 */
import type { PromptIO } from "../../tools/prompt-io";
import type { InputOption, AskChoiceOptions } from "../../tools/user-input";
import type { ToolDefinition } from "../../tools/types";
import { questionTool } from "../../tools/question";
import { approveTool } from "../../tools/approve";
import { broadcast, type WebUiState } from "./state";

let questionSeq = 0;

/** Monotonic, collision-free id for a pending question. */
function nextQuestionId(): string {
  questionSeq += 1;
  return `q${Date.now().toString(36)}-${questionSeq}`;
}

/** Coerce an arbitrary browser payload into the index array `askChoice` expects. */
function toIndexes(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    const n = typeof item === "number" ? item : Number(item);
    if (Number.isInteger(n) && n >= 0) out.push(n);
  }
  return out;
}

/** Coerce an arbitrary browser payload into the string `askText` expects. */
function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

/** Register a pending question, broadcast it, and resolve with the coerced answer. */
function ask<T>(
  state: WebUiState,
  payload: Record<string, unknown>,
  coerce: (value: unknown) => T,
): Promise<T> {
  return new Promise((resolve) => {
    const id = nextQuestionId();
    state.pendingQuestions.set(id, (value) => resolve(coerce(value)));
    broadcast({ type: "question", ts: Date.now(), id, ...payload }, state);
  });
}

/** Browser `PromptIO`: asks over SSE, resolves on `resolveAnswer`. */
export function createWebPromptIO(state: WebUiState): PromptIO {
  return {
    askText(question) {
      return ask(state, { text: question, kind: "text" }, toText);
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
      );
    },
  };
}

/** Settle a pending question by id. Returns false when the id is unknown. */
export function resolveAnswer(state: WebUiState, id: string, value: unknown): boolean {
  const resolver = state.pendingQuestions.get(id);
  if (!resolver) return false;
  state.pendingQuestions.delete(id);
  resolver(value);
  return true;
}

/**
 * Settle every pending question with `undefined` (tools then read empty/`[]`).
 * Called on interrupt/shutdown so a blocked `question`/`approve` never keeps the
 * turn alive after the browser stopped answering.
 */
export function cancelPendingQuestions(state: WebUiState): void {
  const pending = [...state.pendingQuestions.values()];
  state.pendingQuestions.clear();
  for (const resolve of pending) resolve(undefined);
}

/** Minimal agent surface the installer needs (avoids importing `Agent`). */
export interface PromptIOAgent {
  setPromptIO(io?: PromptIO): void;
}

/** Minimal registry surface (avoids importing `ToolRegistry`). */
export interface PromptIORegistry {
  has(name: string): boolean;
  register(tool: ToolDefinition): void;
}

/**
 * Web-only wiring: register the interactive tools, drop `exitOnComplete` from
 * the shared tool context (web turns are interactive, not one-shot — otherwise
 * `question`/`approve` short-circuit), and install the browser `PromptIO`.
 * Terminal mode never calls this, so its behavior is unchanged.
 */
export function installWebPromptIO(deps: {
  state: WebUiState;
  agent: PromptIOAgent;
  registry?: PromptIORegistry;
  toolCtx?: { exitOnComplete?: boolean };
}): PromptIO {
  if (deps.registry) {
    for (const tool of [questionTool, approveTool]) {
      if (!deps.registry.has(tool.name)) deps.registry.register(tool);
    }
  }
  if (deps.toolCtx) deps.toolCtx.exitOnComplete = false;
  const io = createWebPromptIO(deps.state);
  deps.agent.setPromptIO(io);
  return io;
}
