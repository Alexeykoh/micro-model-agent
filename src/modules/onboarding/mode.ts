import type { ReplContext } from "../../cli/repl-commands";
import type { PromptBlock } from "../../core/types";
import { estimateTokens } from "../../llm/token-counter";
import { MEET_SYSTEM_PROMPT, MEET_TOOLS } from "./prompts";

/**
 * Enter meet mode on the shared agent: restrict tools to the allowlist,
 * create the shared onboarding state (carrying the guide block), and inject
 * the interview guide. Meet mode persists across REPL turns until
 * `exitMeetMode` (driven by the `meet_done` sentinel).
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

/** Leave meet mode: remove the guide and restore unrestricted tools. */
export function exitMeetMode(ctx: ReplContext): void {
  const block = ctx.toolCtx.onboarding?.block;
  if (block) ctx.agent.removePromptBlock(block);
  ctx.toolCtx.toolAllowlist = undefined;
  ctx.toolCtx.onboarding = undefined;
}

/** True when the sentinel tool has fired for the active meet session. */
export function isMeetDone(ctx: ReplContext): boolean {
  return ctx.toolCtx.onboarding?.done === true;
}
