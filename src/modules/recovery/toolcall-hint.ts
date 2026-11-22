/**
 * LM-4: маленькие локальные модели часто «не выдают» tool call — это почти всегда
 * харнесс (отсутствует per-model parser / кривой chat-template кванта), а не модель.
 * Возвращает actionable-совет после нескольких отказов.
 */
export interface ToolCallHintInput {
  model: string;
  providerType: string;
  failures: number;
  error: string;
}

const QWEN_RE = /qwen/i;
const LOCAL_TYPES = new Set(["openai-compat", "llama.cpp", "lmstudio", "opencode-go"]);

/** Обёртка с дедупом: возвращает true, если совет записан. */
export function maybeLogToolcallHint(
  input: ToolCallHintInput & { alreadyLogged: boolean },
  log: (cause: string) => void,
): boolean {
  const hint = toolcallParserHint(input);
  if (!hint || input.alreadyLogged) return false;
  log(hint);
  return true;
}

export function toolcallParserHint(input: ToolCallHintInput): string | undefined {
  if (input.failures < 3) return undefined;
  const local = LOCAL_TYPES.has(input.providerType);
  const looksLikeParse = /invalid (tool|arguments)|parse|unexpected|tool_call|malformed/i.test(input.error);
  if (!local || !looksLikeParse) return undefined;
  const parser = QWEN_RE.test(input.model) ? "qwen3_coder" : "per-model parser";
  return (
    `Tool-call failures on local model "${input.model}" look like a harness/parser issue, not model incapacity. ` +
    `Use a per-model tool-call parser (${parser}: vLLM --tool-call-parser / SGLang --tool-call-parser), ` +
    `verify the GGUF chat-template is compatible with llama.cpp (build b8121+), ` +
    `keep quantization >= Q4, set -ctk/-ctv q8_0, and use non-thinking samplers (temp 0.7, top_p 0.8).`
  );
}
