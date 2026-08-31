import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { t } from "../i18n/index";
import type { ToolDefinition, ToolContext, ToolResult } from "./types";
import { isPathInScope } from "../modules/security/path-validator";
import { DEFAULT_SECURITY_CONFIG } from "../config/security";
import { runChunkQuery } from "../modules/context/chunk-query";

export const chunkQueryTool: ToolDefinition = {
  name: "chunk_query",
  icon: "🧩",
  description:
    "Answer a query over a large text (file or inline) by splitting it into chunks and querying the model per chunk in parallel, then optionally synthesizing a final answer. Use when the input is too large for the context window.",
  tags: ["research"],
  /** Multiple LLM calls (parallel chunk queries + synthesis) need a longer budget. */
  timeoutMs: 300000,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The question to answer over the text.",
      },
      input_path: {
        type: "string",
        description: "Path to the large text file (scope-checked). Preferred over text.",
      },
      text: {
        type: "string",
        description: "Inline text. Use only when a file path is not available.",
      },
      chunk_chars: {
        type: "number",
        description: "Approximate chunk size in chars (default 12000).",
      },
      max_parallel: {
        type: "number",
        description:
          "Max parallel chunk queries (default from config.subagent.maxParallelChunkQueries).",
      },
      max_chunk_tokens: {
        type: "number",
        description: "Cap on generated tokens per chunk call (default 1024).",
      },
      max_synthesis_tokens: {
        type: "number",
        description: "Cap on generated tokens for the synthesis call (default 2048).",
      },
      reasoning_effort: {
        type: "string",
        enum: ["none", "low", "medium", "high", "max"],
        description:
          'Reasoning effort for chunk/synthesis calls (default "none"). "none" prevents long thinking chains from eating the token budget on reasoning models.',
      },
      synthesize: {
        type: "boolean",
        description: "Run a final synthesis call over chunk answers (default true).",
      },
    },
    required: ["query"],
  },
  handler: async (ctx: ToolContext, args): Promise<ToolResult> => {
    const query = String(args.query || "");
    const inputPath = args.input_path ? String(args.input_path) : undefined;
    const text = args.text ? String(args.text) : undefined;

    if (!query) return { success: false, output: t("tool.chunk_query_no_query") };
    if (!inputPath && !text) return { success: false, output: t("tool.chunk_query_no_input") };

    let content = text || "";
    if (inputPath) {
      // Same policy as read_file: global security paths (denied patterns
      // like .env/keys) + subagent scope.
      const resolvedInput = resolve(ctx.baseDir, inputPath);
      const check = isPathInScope(
        ctx.baseDir,
        resolvedInput,
        ctx.scope,
        ctx.config?.security?.paths || DEFAULT_SECURITY_CONFIG.paths,
      );
      if (!check.allowed) {
        return { success: false, output: `[SCOPE] ${check.reason || "Path not allowed"}` };
      }
      try {
        content = readFileSync(resolvedInput, "utf8");
      } catch (e: any) {
        return { success: false, output: `Cannot read ${inputPath}: ${e.message}` };
      }
    }

    if (!ctx.llmProvider) {
      return { success: false, output: "chunk_query: missing llmProvider in context" };
    }

    const maxParallel =
      typeof args.max_parallel === "number"
        ? args.max_parallel
        : (ctx.config.subagent?.maxParallelChunkQueries ?? 4);

    const res = await runChunkQuery(ctx.llmProvider, content, query, {
      chunkChars: typeof args.chunk_chars === "number" ? args.chunk_chars : undefined,
      maxParallel,
      synthesize: typeof args.synthesize === "boolean" ? args.synthesize : undefined,
      maxChunkTokens: typeof args.max_chunk_tokens === "number" ? args.max_chunk_tokens : undefined,
      maxSynthesisTokens:
        typeof args.max_synthesis_tokens === "number" ? args.max_synthesis_tokens : undefined,
      reasoningEffort: (["none", "low", "medium", "high", "max"] as const).includes(
        args.reasoning_effort as "none" | "low" | "medium" | "high" | "max",
      )
        ? (args.reasoning_effort as "none" | "low" | "medium" | "high" | "max")
        : undefined,
      logger: ctx.logger,
    });

    ctx.logger.debug(
      `chunk_query: ${res.chunks} chunk(s), ${res.totalChars} chars, max parallel ${res.maxParallelObserved}`,
    );

    return {
      success: true,
      output: `[chunk_query] ${res.chunks} chunk(s), ${res.totalChars} chars, max parallel ${res.maxParallelObserved}\n\n${res.synthesis || res.answers.join("\n")}`,
    };
  },
};
