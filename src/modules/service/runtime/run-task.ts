/**
 * Один ход над сессией (task) поверх её `SessionRunner`.
 *
 * Копирует синтез tool-call id из web-раннера (`makeRunAgent`): `ToolEvent` id не
 * несёт, поэтому `start`/`end` матчатся LIFO по имени. Вместо webui-состояния
 * пишет в транспортно-чистый `ServiceForwarder`. MoE/контекст/тулы — ядровые.
 *
 * Structured output (§8.2): при `output.format === "json"` в вход добавляется
 * инструкция; ответ парсится/валидируется, при провале — один retry, иначе
 * `outputInvalid`.
 */
import type { AgentResult, ToolEvent } from "../../../core/types";
import type { SessionRunner } from "../../../core/bootstrap/session-runner";
import type { ToolCall, ToolResult } from "../../../tools/types";
import { errMsg } from "../../../utils/error";
import { planEventFor } from "../../webui/host-state";
import type { PlanSnapshot } from "../../webui/session/forward";
import { buildOutputInstruction, parseStructured } from "./output";
import type { TaskRecord, TaskUsage } from "./task-registry";
import type { ServiceForwarder } from "./event-bridge";

/** Итог хода: текст/успех/usage; `data` — структурный вывод; `error` — причина. */
export interface RunTaskResult {
  success: boolean;
  text: string;
  usage: TaskUsage;
  data?: unknown;
  outputInvalid?: boolean;
  /** Ход в job-режиме попытался вызвать интерактивный/запрещённый allowlist'ом тул. */
  forbidden?: boolean;
  error?: string;
}

/** Интерактивные тулы, запрещённые в job-режиме (спека §5.2). */
const INTERACTIVE_TOOLS = new Set(["question", "approve"]);

export interface RunTaskOptions {
  runner: SessionRunner;
  task: TaskRecord;
  forwarder: ServiceForwarder;
  /** Колбэк снапшота плана (эмит `plan`-envelope после plan/todo-тула). */
  onPlan?: (plan: PlanSnapshot) => void;
}

/** Гоняет один ход агента и маппит его колбэки в события задачи. */
export async function runTask(opts: RunTaskOptions): Promise<RunTaskResult> {
  const { runner, task, forwarder } = opts;

  const pendingIds = new Map<string, string[]>();
  let toolSeq = 0;
  const startId = (tool: string): string => {
    const id = `t${++toolSeq}`;
    const stack = pendingIds.get(tool) ?? [];
    stack.push(id);
    pendingIds.set(tool, stack);
    return id;
  };
  const endId = (tool: string): string => pendingIds.get(tool)?.pop() ?? `t-stray-${++toolSeq}`;
  const callFor = (ev: ToolEvent, id: string): ToolCall => ({
    id,
    name: ev.tool,
    arguments: ev.args,
  });
  const resultFor = (ev: ToolEvent): ToolResult => ({
    success: !ev.error,
    output: ev.output ?? "",
    ...(ev.imageRefs?.length ? { imageRefs: ev.imageRefs } : {}),
    ...(ev.images?.length ? { images: ev.images } : {}),
  });

  // Job-режим: попытка интерактивного тула или тула вне allowlist = tool_forbidden.
  const allowSet =
    task.mode === "job" && task.toolAllowlist ? new Set(task.toolAllowlist) : null;
  let forbidden = false;

  const callAgent = (text: string): Promise<AgentResult> =>
    runner.agent.run(
      text,
      (chunk) => forwarder.onText(chunk),
      () => {},
      (ev: ToolEvent) => {
        if (ev.type === "start") {
          forwarder.onToolStart(callFor(ev, startId(ev.tool)));
          return;
        }
        if (
          task.mode === "job" &&
          (INTERACTIVE_TOOLS.has(ev.tool) || (allowSet !== null && !allowSet.has(ev.tool)))
        ) {
          forbidden = true;
        }
        forwarder.onToolEnd(callFor(ev, endId(ev.tool)), resultFor(ev), ev.duration ?? 0);
        const plan = planEventFor(ev.tool, runner.execModule);
        if (plan) opts.onPlan?.(plan);
      },
      (phase) => forwarder.onPhase(phase),
      (reasoning) => forwarder.onReasoning(reasoning),
    );

  const usageOf = (result: AgentResult): TaskUsage => ({
    promptTokens: result.promptTokens ?? 0,
    completionTokens: result.completionTokens ?? 0,
    costUsd: result.totalCost ?? 0,
  });
  const finish = (r: Omit<RunTaskResult, "forbidden">): RunTaskResult =>
    forbidden ? { ...r, forbidden: true } : r;

  const wantsJson = task.output?.format === "json" && !!task.output;
  const baseInput = wantsJson
    ? `${task.input}\n\n${buildOutputInstruction(task.output!)}`
    : task.input;

  try {
    let result = await callAgent(baseInput);
    if (wantsJson && result.success && task.output) {
      const parsed = parseStructured(result.text, task.output);
      if (!parsed.ok) {
        const retryInput = `${baseInput}\n\nPrevious attempt failed validation: ${parsed.detail}. Return ONLY valid JSON.`;
        result = await callAgent(retryInput);
        const retryParsed = parseStructured(result.text, task.output);
        forwarder.flush();
        if (!retryParsed.ok) {
          return finish({
            success: false,
            text: result.text,
            usage: usageOf(result),
            outputInvalid: true,
            error: `output_invalid: ${retryParsed.detail}`,
          });
        }
        return finish({ success: true, text: result.text, data: retryParsed.data, usage: usageOf(result) });
      }
      forwarder.flush();
      return finish({ success: true, text: result.text, data: parsed.data, usage: usageOf(result) });
    }
    forwarder.flush();
    return finish({
      success: result.success,
      text: result.text,
      usage: usageOf(result),
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (err) {
    forwarder.flush();
    return finish({
      success: false,
      text: "",
      usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
      error: errMsg(err),
    });
  }
}
