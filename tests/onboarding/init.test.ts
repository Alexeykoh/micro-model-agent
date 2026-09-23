import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { runInit } from "../../src/modules/onboarding/init";
import { INIT_SYSTEM_PROMPT, INIT_TOOLS } from "../../src/modules/onboarding/prompts";
import { t } from "../../src/i18n/index";
import { pc } from "../../src/ui/colors";

const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function setTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

afterEach(() => {
  if (originalIsTTY) Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
});

function fakeCtx() {
  return {
    config: { provider: { baseUrl: "http://x/v1", apiKey: "k" }, model: "m" },
    baseDir: "/tmp/ws",
    toolCtx: {},
    agent: {
      pushPromptBlock: vi.fn(),
      removePromptBlock: vi.fn(),
    },
    output: { writeLine: vi.fn() },
    runAgent: vi.fn(async () => {}),
  } as any;
}

describe("runInit", () => {
  beforeEach(() => {
    setTTY(true);
  });

  it("sets an init allowlist, runs once, then restores state", async () => {
    const ctx = fakeCtx();
    let captured: string[] | undefined;
    let capturedWritePaths: string[] | undefined;
    ctx.runAgent = vi.fn(async () => {
      captured = [...ctx.toolCtx.toolAllowlist];
      capturedWritePaths = [...ctx.toolCtx.writePathAllowlist];
    });
    const ok = await runInit(ctx, { preflight: async () => ({ ok: true, reason: "ok", ms: 1 }) });
    expect(ok).toBe(true);
    expect(captured).toEqual([...INIT_TOOLS]);
    expect(capturedWritePaths).toEqual([join("/tmp/ws", "AGENTS.md")]);
    expect(ctx.runAgent).toHaveBeenCalledOnce();
    expect(ctx.agent.pushPromptBlock).toHaveBeenCalledOnce();
    expect(ctx.agent.pushPromptBlock).toHaveBeenCalledWith(
      expect.objectContaining({ content: INIT_SYSTEM_PROMPT }),
    );
    expect(ctx.agent.removePromptBlock).toHaveBeenCalledOnce();
    expect(ctx.toolCtx.toolAllowlist).toBeUndefined();
    expect(ctx.toolCtx.writePathAllowlist).toBeUndefined();
  });

  it("refuses when preflight fails", async () => {
    const ctx = fakeCtx();
    const ok = await runInit(ctx, { preflight: async () => ({ ok: false, reason: "no-model", ms: 1 }) });
    expect(ok).toBe(false);
    expect(ctx.runAgent).not.toHaveBeenCalled();
    expect(ctx.output.writeLine).toHaveBeenCalled();
  });

  it("refuses while another onboarding mode is active", async () => {
    const ctx = fakeCtx();
    ctx.toolCtx.onboarding = { done: false };
    const ok = await runInit(ctx, { preflight: async () => ({ ok: true, reason: "ok", ms: 1 }) });
    expect(ok).toBe(false);
    expect(ctx.runAgent).not.toHaveBeenCalled();
  });

  it("uses the full init allowlist and removes the block on failure", async () => {
    const ctx = fakeCtx();
    let captured: string[] | undefined;
    ctx.runAgent = vi.fn(async () => {
      captured = [...ctx.toolCtx.toolAllowlist];
      throw new Error("boom");
    });
    await expect(
      runInit(ctx, { preflight: async () => ({ ok: true, reason: "ok", ms: 1 }) }),
    ).rejects.toThrow("boom");
    expect(captured).toEqual([...INIT_TOOLS]);
    expect(ctx.toolCtx.toolAllowlist).toBeUndefined();
    expect(ctx.toolCtx.writePathAllowlist).toBeUndefined();
    expect(ctx.agent.removePromptBlock).toHaveBeenCalledOnce();
    const block = ctx.agent.pushPromptBlock.mock.calls[0]?.[0];
    expect(block.content).toBe(INIT_SYSTEM_PROMPT);
    expect(block.kind).toBeUndefined();
  });

  it("returns false and does not run when stdout is not a TTY", async () => {
    setTTY(false);
    const ctx = fakeCtx();
    const ok = await runInit(ctx, { preflight: async () => ({ ok: true, reason: "ok", ms: 1 }) });
    expect(ok).toBe(false);
    expect(ctx.runAgent).not.toHaveBeenCalled();
    expect(ctx.output.writeLine).toHaveBeenCalledOnce();
    expect(ctx.output.writeLine).toHaveBeenCalledWith(pc.yellow(t("onboarding.non_interactive")));
    expect(ctx.agent.pushPromptBlock).not.toHaveBeenCalled();
  });
});
