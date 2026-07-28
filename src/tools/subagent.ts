import { generateSubagentToolCallId } from "./id-gen.js";
import { parseToolCalls } from "./parse-tool-call.js";
import type { LLMProvider, ChatMessage } from "../llm/provider.js";
import { LMStudioNative } from "../llm/lmstudio-native.js";
import { ToolRegistry } from "./registry.js";
import type { ParsedToolCall } from "./types.js";
import type { ToolExecutor } from "../agent/tool-executor.js";
import { ContextManager } from "../agent/context.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";
import { checkFileSyntax } from "./syntax-check.js";
import type { OutputRenderer } from "../ui/renderer.js";
import {
  logInfo,
  logDebug,
  logWarn,
  logToolCall,
  logToolOutput,
} from "../logger.js";
import { getLLMConfig } from "../config/config.js";
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validateToolCall } from "../subagent/validation.js";
export { validateToolCall };

/**
 * Изолированный цикл агента для субагентов.
 *
 * Субагенты работают в изолированном контексте — они не видят
 * историю родительского агента, но получают информацию о структуре
 * проекта (файлы, зависимости, tsconfig).
 *
 * Используется для:
 * - Создания отдельных файлов в multi-file проектах
 * - Запуска верификации (tsc --noEmit)
 * - Изоляции задач для предотвращения потери контекста
 *
 * @module tools/subagent
 */

// ─── Types ────────────────────────────────────────────────

/** Результат выполнения изолированного цикла субагента */
export interface IsolatedLoopResult {
  createdFiles: string[];
  errors: string[];
  summary: string;
  turns: number;
}

// ─── Context builder ──────────────────────────────────────

import { buildSubagentContext } from "../subagent/context.js";
export { buildSubagentContext };

import { buildSpecialistTask, isTrivialError } from "../subagent/errors.js";
export { buildSpecialistTask, isTrivialError };

// ─── Tool call parsing ───────────────────────────────────
// validateToolCall moved to src/subagent/validation.ts

import { doChat } from "../subagent/chat.js";
export { doChat };

// ─── Isolated agent loop ──────────────────────────────────

/**
 * Запуск изолированного цикла агента (субагент).
 *
 * Субагент:
 * - Получает свежий контекст (system prompt + задача + info о проекте)
 * - Работает максимум 20 ходов
 * - Не может создавать вложенных субагентов (max depth 1)
 * - Автоматически компактирует контекст при необходимости
 * - Отслеживает созданные файлы и ошибки
 *
 * @returns Результат: созданные файлы, ошибки, краткое описание, количество ходов
 */
export async function runIsolatedLoop(
  provider: LLMProvider,
  registry: ToolRegistry,
  task: string,
  existingFiles: string,
  cwd: string,
  quiet: boolean,
  renderer: OutputRenderer,
  toolExecutor?: ToolExecutor,
  mode?: string,
  toolModel?: string,
  maxStepsParam?: number,
): Promise<IsolatedLoopResult> {
  const createdFiles: string[] = [];
  const errors: string[] = [];
  const startTime = performance.now();

  // Two-model pipeline: если toolModel задана, создаём отдельный провайдер
  let effectiveProvider = provider;
  if (toolModel && provider instanceof LMStudioNative) {
    effectiveProvider = new LMStudioNative(
      (provider as any).baseUrl,
      toolModel,
      provider.contextWindow,
    );
    logInfo(
      "SUBAGENT",
      `using tool model: ${toolModel} (main: ${provider.model})`,
    );
  }

  logInfo(
    "SUBAGENT",
    `START | task: "${task.slice(0, 200)}" | context window: ${effectiveProvider.contextWindow}`,
  );

  // Always build auto-context from project, even if model didn't pass existingFiles
  const autoContext = buildSubagentContext(cwd);
  const mergedContext = existingFiles
    ? existingFiles + "\n" + autoContext
    : autoContext;

  if (mergedContext) {
    logDebug(
      "SUBAGENT",
      `context (${mergedContext.split("\n").length} lines):\n${mergedContext}`,
    );
  }

  const systemPrompt = buildSystemPrompt(undefined, (mode || "base") as any);

  const contextInfo = mergedContext
    ? `\n\nКонтекст проекта:\n${mergedContext}\nПосмотри package.json для списка пакетов. Используй read_file для чтения существующих файлов.`
    : "";

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: task + contextInfo },
  ];

  const ctx = new ContextManager(effectiveProvider.contextWindow);
  const maxSteps = maxStepsParam ?? 20;
  let toolCallCount = 0;

  for (let step = 0; step < maxSteps; step++) {
    await ctx.updateTokens(messages);

    if (step === 0 || step % 5 === 0) {
      logDebug(
        "SUBAGENT",
        `step ${step} | ${messages.length} msgs | ${ctx.totalTokens} tokens (${ctx.usagePercent.toFixed(1)}%)`,
      );
    }

    if (ctx.needsCompact && messages.length > 6) {
      logInfo(
        "SUBAGENT",
        `COMPACT at step ${step} | ${ctx.totalTokens} tokens (${ctx.usagePercent.toFixed(1)}%)`,
      );
      messages.splice(0, messages.length, ...ctx.compact(messages));
      await ctx.updateTokens(messages);
      logInfo(
        "SUBAGENT",
        `after compact | ${messages.length} msgs | ${ctx.totalTokens} tokens`,
      );
    }

    // После tool call увеличиваем max_tokens чтобы модель успела сгенерировать контент после reasoning
    const hasToolResult = messages.some((m) => m.role === "tool");
    const llmCfg = getLLMConfig();
    const maxTokens = hasToolResult ? llmCfg.maxTokensAfterTool : undefined;

    const { response } = await doChat(
      effectiveProvider,
      messages,
      renderer!,
      renderer?.abortSignal,
      1,
      false,
      "subagent",
      maxTokens,
    );

    if (!response.trim()) {
      logDebug("SUBAGENT", `empty response at step ${step}, stopping`);
      break;
    }

    messages.push({ role: "assistant", content: response });

    const { validCalls } = parseToolCalls(response);

    if (validCalls.length === 0) {
      logDebug("SUBAGENT", `no valid tool calls at step ${step}, stopping`);
      break;
    }

    for (const call of validCalls) {
      const { parsed, cmd } = call;
      const isBash = parsed.name === "bash";
      const toolId = generateSubagentToolCallId();
      toolCallCount++;

      let toolOutput = "";
      let toolExitCode = 0;

      if (parsed.name === "subagent") {
        toolOutput = "Subagents cannot spawn subagents (max depth 1)";
        toolExitCode = 1;
        logWarn("SUBAGENT", `nested subagent blocked at step ${step}`);
      } else if (!isBash) {
        const preview =
          parsed.name === "write_file"
            ? String(parsed.arguments.path ?? "").slice(-60)
            : parsed.name === "edit_file"
              ? String(parsed.arguments.path ?? "").slice(-60)
              : JSON.stringify(parsed.arguments).slice(0, 80);
        logToolCall(`sub:${parsed.name}`, preview);

        const hookCmd = isBash
          ? String(cmd)
          : `${parsed.name} ${JSON.stringify(parsed.arguments)}`;
        const execResult = toolExecutor
          ? await toolExecutor.execute(
              {
                id: toolId,
                name: parsed.name,
                arguments: parsed.arguments,
              } as any,
              { cwd, quiet: false },
              hookCmd,
            )
          : null;
        const result = execResult?.result ?? {
          stdout: "",
          stderr: "ToolExecutor not available",
          exitCode: 1,
          truncated: false,
        };
        toolOutput = result.stdout || result.stderr || "(no output)";
        toolExitCode = result.exitCode;

        logToolOutput(`sub:${parsed.name}`, toolOutput, toolExitCode);

        if (toolExitCode !== 0) {
          logDebug(
            "SUBAGENT",
            `tool ${parsed.name} failed: exit ${toolExitCode} | ${toolOutput.slice(0, 200)}`,
          );
        }

        if (
          toolExitCode === 0 &&
          (parsed.name === "write_file" || parsed.name === "edit_file")
        ) {
          const filePath = String(parsed.arguments.path ?? "");
          if (filePath && !createdFiles.includes(filePath)) {
            createdFiles.push(filePath);
            logInfo("SUBAGENT", `created: ${filePath}`);
          }
        }

        if (
          toolExitCode === 0 &&
          (parsed.name === "write_file" || parsed.name === "edit_file")
        ) {
          const filePath = String(parsed.arguments.path ?? "");
          if (filePath && /\.(ts|tsx|js|jsx|json)$/.test(filePath)) {
            const { isAbsolute, relative } = await import("node:path");
            const relPath = isAbsolute(filePath)
              ? relative(cwd, filePath).replace(/\\/g, "/")
              : filePath;
            const syntaxResult = checkFileSyntax(relPath, cwd);
            if (syntaxResult !== "OK") {
              errors.push(`${filePath}: ${syntaxResult.split("\n")[0]}`);
              toolOutput += `\nSYNTAX ERROR: ${syntaxResult}`;
              logWarn(
                "SUBAGENT",
                `syntax error in ${filePath}: ${syntaxResult.split("\n")[0]}`,
              );
            }
          }
        }
      } else {
        logToolCall("sub:bash", String(cmd).slice(0, 80));

        const bashExecResult = toolExecutor
          ? await toolExecutor.execute(
              {
                id: toolId,
                name: "bash",
                arguments: { cmd, timeout: parsed.arguments?.timeout ?? 30 },
              } as any,
              { cwd, quiet: false },
              String(cmd),
            )
          : null;
        const result = bashExecResult?.result ?? {
          stdout: "",
          stderr: "ToolExecutor not available",
          exitCode: 1,
          truncated: false,
        };
        toolOutput = result.stdout || result.stderr || "(no output)";
        toolExitCode = result.exitCode;

        logToolOutput("sub:bash", toolOutput, toolExitCode);

        if (toolExitCode !== 0) {
          logDebug(
            "SUBAGENT",
            `bash failed: exit ${toolExitCode} | ${toolOutput.slice(0, 200)}`,
          );
          // Если bash падает из-за отсутствия shell —提示 модель использовать write_file
          if (/pwsh|powershell|not recognized|not found/i.test(toolOutput)) {
            toolOutput +=
              "\n\n[HINT] Shell unavailable on this system. Use write_file tool to create files manually. Do NOT retry bash commands.";
          }
        }
      }

      messages.push({
        role: "tool",
        content: toolOutput.slice(0, 8000),
        tool_call_id: toolId,
      });
      messages.push({ role: "user", content: "Continue." });
    }
  }

  const turns = messages.filter((m) => m.role === "assistant").length;
  const elapsedMs = performance.now() - startTime;

  await ctx.updateTokens(messages);
  const finalTokens = ctx.totalTokens;
  const finalUsage = ctx.usagePercent;

  logInfo(
    "SUBAGENT",
    `DONE | ${turns} turns | ${toolCallCount} tool calls | ${createdFiles.length} files created | ${errors.length} errors | ${finalTokens} tokens (${finalUsage.toFixed(1)}%) | ${(elapsedMs / 1000).toFixed(1)}s`,
  );

  // Собираем список использованных инструментов из истории
  const toolsUsed = [
    ...new Set(
      messages
        .filter((m) => m.role === "assistant")
        .flatMap((m) => {
          const calls = m.content.matchAll(/<tool_call>\{"name":"([^"]+)"/g);
          return [...calls].map((c) => c[1]);
        }),
    ),
  ];
  const toolsStr =
    toolsUsed.length > 0 ? `\nTools used: ${toolsUsed.join(", ")}` : "";

  const summary =
    createdFiles.length > 0
      ? `[Subagent done — ${createdFiles.length} file(s), ${turns} turns]\nFiles: ${createdFiles.join(", ")}${toolsStr}${errors.length > 0 ? `\nErrors: ${errors.join("; ")}` : ""}`
      : `[Subagent done — no files, ${turns} turns]${toolsStr}${errors.length > 0 ? `\nErrors: ${errors.join("; ")}` : ""}`;

  return { createdFiles, errors, summary, turns };
}

import { subagentDefinition } from "../subagent/definition.js";
export { subagentDefinition };
