// `ui.draftMode: live | after-review` — буфер финального черновика до
// одобрения critic/audit.
import { describe, expect, it, vi } from "vitest";
import { createDraftSink } from "../src/core/agent/draft-buffer";
import { runFinalGates, type GatesInput } from "../src/core/agent/loop-gates";
import { createLoopState } from "../src/core/agent/loop-state";
import type { AgentDeps } from "../src/core/agent";

describe("draft buffer", () => {
  it("live mode forwards text immediately and ignores flush/discard", () => {
    const out: string[] = [];
    const draft = createDraftSink((chunk) => out.push(chunk), "live");
    draft.onText?.("a");
    draft.onText?.("b");
    expect(out).toEqual(["a", "b"]);
    draft.discard();
    expect(out).toEqual(["a", "b"]);
    draft.flush();
    expect(out).toEqual(["a", "b"]);
  });

  it("after-review holds text until flush and drops it on discard", () => {
    const out: string[] = [];
    const draft = createDraftSink((chunk) => out.push(chunk), "after-review");
    draft.onText?.("draft");
    draft.onText?.(" text");
    expect(out).toEqual([]);
    draft.flush();
    expect(out).toEqual(["draft text"]);

    draft.onText?.("rejected");
    draft.discard();
    draft.flush();
    expect(out).toEqual(["draft text"]);
  });

  it("after-review with no sink does not throw", () => {
    const draft = createDraftSink(undefined, "after-review");
    expect(draft.onText).toBeUndefined();
    draft.flush();
    draft.discard();
  });
});

function gateHost(overrides: Partial<AgentDeps> = {}): AgentDeps {
  return {
    contextManager: {
      addMessage: vi.fn(),
      getActiveHistory: () => [],
    },
    logger: { diagnostic: vi.fn() },
    hallucinationDetector: { getConsistencyCheck: () => ({ trackDecision: vi.fn() }) },
    config: { session: { autoSave: false }, ui: {} },
    baseDir: process.cwd(),
    onDiagnostic: vi.fn(),
    ...overrides,
  } as unknown as AgentDeps;
}

function gateInput(
  gates: { critic: "pass" | "retry"; audit?: "pass" | "reject" | null },
  draft: ReturnType<typeof createDraftSink>,
): GatesInput {
  return {
    state: (() => {
      const state = createLoopState();
      state.iteration = 1;
      return state;
    })(),
    textContent: "ANSWER",
    reasoningContent: "",
    input: "task",
    slog: {
      saveAssistantMessage: vi.fn(),
      logAssistant: vi.fn(),
      logCritic: vi.fn(),
      logRetract: vi.fn(),
      logDiagnosticEvent: vi.fn(),
      logAudit: vi.fn(),
    },
    hallucinationGate: { evaluate: vi.fn(async () => ({ action: "accept" })) },
    criticGate: { evaluate: vi.fn(async () => gates.critic) },
    auditGate: { evaluate: vi.fn(async () => ({ action: gates.audit ?? "pass" })) },
    draft,
  } as unknown as GatesInput;
}

describe("runFinalGates with after-review draft", () => {
  it("drops a draft rejected by the critic", async () => {
    const host = gateHost();
    const out: string[] = [];
    const draft = createDraftSink((chunk) => out.push(chunk), "after-review");
    draft.onText?.("bad draft");
    const input = gateInput({ critic: "retry" }, draft);

    const result = await runFinalGates(host, input);

    expect(result.kind).toBe("continue");
    expect(out).toEqual([]);
    expect(input.slog.logAssistant).not.toHaveBeenCalled();
    expect(input.slog.saveAssistantMessage).not.toHaveBeenCalled();
  });

  it("flushes and records only the accepted answer", async () => {
    const host = gateHost();
    const out: string[] = [];
    const draft = createDraftSink((chunk) => out.push(chunk), "after-review");
    draft.onText?.("accepted answer");
    const input = gateInput({ critic: "pass", audit: "pass" }, draft);

    const result = await runFinalGates(host, input);

    expect(result.kind).toBe("break");
    expect(out).toEqual(["accepted answer"]);
    expect(host.contextManager.addMessage).toHaveBeenCalledWith({
      role: "assistant",
      content: "ANSWER",
    });
    expect(input.slog.logAssistant).toHaveBeenCalled();
  });

  it("drops the draft when the audit rejects it", async () => {
    const host = gateHost();
    const out: string[] = [];
    const draft = createDraftSink((chunk) => out.push(chunk), "after-review");
    draft.onText?.("audit rejected");
    const input = gateInput({ critic: "pass", audit: "reject" }, draft);

    const result = await runFinalGates(host, input);

    expect(result.kind).toBe("ok");
    expect(out).toEqual([]);
    expect(input.slog.logAssistant).not.toHaveBeenCalled();
    expect(input.slog.saveAssistantMessage).not.toHaveBeenCalled();
  });
});
