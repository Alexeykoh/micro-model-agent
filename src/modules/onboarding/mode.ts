// Meet-режим на shared-агенте: allowlist тулов и гайд интервью между ходами REPL.
import type { ReplContext } from "../../cli/repl-commands";
import type { PromptBlock } from "../../core/types";
import { estimateTokens } from "../../llm/token-counter";
import { MEET_SYSTEM_PROMPT, MEET_TOOLS } from "./prompts";

/**
 * Входит в meet-режим на shared-агенте: режет тулы до allowlist, создаёт
 * shared-состояние онбординга (с блоком гайда) и инжектит гайд интервью.
 * Режим живёт между ходами REPL до `exitMeetMode` (по сентинелу `meet_done`).
 */
export function enterMeetMode(ctx: ReplContext): void {
  const block: PromptBlock = {
    content: MEET_SYSTEM_PROMPT,
    priority: "high",
    essential: true,
    estimatedTokens: estimateTokens(MEET_SYSTEM_PROMPT),
  };
  ctx.toolCtx.toolAllowlist = [...MEET_TOOLS];
  ctx.toolCtx.onboarding = { done: false, block };
  ctx.agent.pushPromptBlock(block);
}

/** Выходит из meet-режима: убирает гайд и возвращает полные тулы. */
export function exitMeetMode(ctx: ReplContext): void {
  const block = ctx.toolCtx.onboarding?.block;
  if (block) ctx.agent.removePromptBlock(block);
  ctx.toolCtx.toolAllowlist = undefined;
  ctx.toolCtx.onboarding = undefined;
}

/** True, когда сентинел-тул сработал в активной meet-сессии. */
export function isMeetDone(ctx: ReplContext): boolean {
  return ctx.toolCtx.onboarding?.done === true;
}
