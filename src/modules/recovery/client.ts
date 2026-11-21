/**
 * RCV-2: recovery-сабагент. Свежий контекст (только ошибка + задача), рассуждения
 * провайдера не выключаются — в отличие от основного хода. Возвращает ровно одно
 * исправление вызова тула или `skip`. Fail-open: null при любой деградации.
 */
import type { LLMProvider, Message } from "../../llm/provider";
import {
  RECOVERY_ERROR_CHARS,
  RECOVERY_MAX_TOKENS,
  RECOVERY_TIMEOUT_MS,
} from "./constants";

export interface RecoveryInput {
  task: string;
  tool: string;
  args: Record<string, unknown>;
  error: string;
  availableTools: string[];
}

export interface RecoveryCall {
  name: string;
  arguments: Record<string, unknown>;
}

export type RecoveryProposal =
  | { skip: true; reason: string }
  | { call: RecoveryCall; reason: string };

export const RECOVERY_SYSTEM_PROMPT = `You repair ONE failed tool call for a small AI agent.
The agent is executing a task and its last tool call failed with a deterministic validation or policy error.
Return JSON ONLY, no prose:
{"call":{"name":"tool_name","arguments":{...}},"reason":"one line"}
or {"skip":true,"reason":"one line"} if the step cannot be repaired.
Rules:
- Use ONLY tool names from the AVAILABLE list. Never invent a tool.
- Fix the EXACT cause of the error (forbidden shell operator, wrong id, wrong arguments, missing file in plan).
- Keep the same intent as the original call; do not change the task.
- Prefer a concrete corrected call over advice. "skip" is allowed only when no correction exists.`;

class RecoveryTimeout extends Error {
  constructor(readonly budgetMs: number) {
    super(`recovery call exceeded ${budgetMs}ms`);
    this.name = "RecoveryTimeout";
  }
}

function render(input: RecoveryInput): string {
  return [
    `TASK: ${input.task.slice(0, 1200)}`,
    `FAILED TOOL: ${input.tool}`,
    `ARGUMENTS: ${JSON.stringify(input.args).slice(0, 1200)}`,
    `ERROR: ${input.error.slice(0, RECOVERY_ERROR_CHARS)}`,
    `AVAILABLE TOOLS: ${input.availableTools.join(", ")}`,
  ].join("\n");
}

function parseProposal(raw: string, allowed: Set<string>): RecoveryProposal | null {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const reason = typeof obj.reason === "string" ? obj.reason.slice(0, 200) : "";
  if (obj.skip === true) return { skip: true, reason };
  const call = obj.call;
  if (!call || typeof call !== "object") return null;
  const { name, arguments: args } = call as Record<string, unknown>;
  if (typeof name !== "string" || !allowed.has(name)) return null;
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return {
    call: { name, arguments: args as Record<string, unknown> },
    reason,
  };
}

export class RecoveryClient {
  constructor(private readonly provider: LLMProvider) {}

  async propose(input: RecoveryInput, signal?: AbortSignal): Promise<RecoveryProposal | null> {
    const allowed = new Set(input.availableTools);
    if (!allowed.has(input.tool)) return null;
    const messages: Message[] = [
      { role: "system", content: RECOVERY_SYSTEM_PROMPT },
      { role: "user", content: render(input) },
    ];
    let raw = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new AbortController();
    const onAbort = (): void => deadline.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      timer = setTimeout(() => deadline.abort(), RECOVERY_TIMEOUT_MS);
      for await (const chunk of this.provider.chat(messages, [], deadline.signal, {
        maxTokens: Math.min(RECOVERY_MAX_TOKENS, this.provider.maxCompletionTokens ?? RECOVERY_MAX_TOKENS),
      })) {
        if (chunk.type === "text" && chunk.content) raw += chunk.content;
      }
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (!raw.trim()) return null;
    // Таймаут — тоже fail-open, даже если часть текста уже пришла.
    if (deadline.signal.aborted && signal?.aborted !== true) return null;
    return parseProposal(raw, allowed);
  }
}

export { RecoveryTimeout };
