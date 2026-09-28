// Генерация/улучшение AGENTS.md: один прогон агента со строгим allowlist без bash.
import { join } from "path";
import type { ReplContext } from "../../cli/repl-commands";
import type { PromptBlock } from "../../core/types";
import { estimateTokens } from "../../llm/token-counter";
import type { PreflightResult } from "../providers/preflight";
import { preflightFromConfig } from "../providers/preflight";
import { INIT_SYSTEM_PROMPT, INIT_TOOLS } from "./prompts";
import { t } from "../../i18n/index";
import { pc } from "../../ui/colors";

/** Опции генерации AGENTS.md. */
export interface RunInitOptions {
  /** Шов для тестов: подмена проверки провайдера. */
  preflight?: () => Promise<PreflightResult>;
}

/**
 * Генерирует или улучшает AGENTS.md воркспейса. Один прогон агента со
 * строгим allowlist (без bash). Возвращает false, когда провайдер недоступен
 * или уже активен другой онбординг-режим.
 */
export async function runInit(ctx: ReplContext, opts: RunInitOptions = {}): Promise<boolean> {
  if (ctx.toolCtx.onboarding) {
    ctx.output.writeLine(pc.yellow(t("onboarding.already")));
    return false;
  }

  if (process.stdout.isTTY !== true) {
    ctx.output.writeLine(pc.yellow(t("onboarding.non_interactive")));
    return false;
  }

  const check = opts.preflight ?? (() => preflightFromConfig(ctx));

  const pre = await check();
  if (!pre.ok) {
    ctx.output.writeLine(pc.yellow(t("repl.init_unavailable", { reason: pre.reason })));
    ctx.output.writeLine(t("repl.meet_unavailable_hint"));
    return false;
  }

  const block: PromptBlock = {
    content: INIT_SYSTEM_PROMPT,
    priority: "high",
    essential: true,
    estimatedTokens: estimateTokens(INIT_SYSTEM_PROMPT),
  };
  ctx.agent.pushPromptBlock(block);
  ctx.toolCtx.toolAllowlist = [...INIT_TOOLS];
  ctx.toolCtx.writePathAllowlist = [join(ctx.baseDir, "AGENTS.md")];
  try {
    await ctx.runAgent(
      t("repl.init_start_prompt", { dir: join(ctx.baseDir, "AGENTS.md") }),
    );
  } finally {
    ctx.agent.removePromptBlock(block);
    ctx.toolCtx.toolAllowlist = undefined;
    ctx.toolCtx.writePathAllowlist = undefined;
  }
  return true;
}
