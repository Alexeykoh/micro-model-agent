import { describe, expect, it, vi } from "vitest";
import { runFinalGates, type GatesInput } from "../src/core/agent/loop-gates";
import { createLoopState } from "../src/core/agent/loop-state";
import type { AgentDeps } from "../src/core/agent";

/**
 * Сессия ses_mwj70h1f: read-only `bash`/`read_file` инкрементили
 * mutationsSinceCritic, из-за чего critic получал пакет без ANSWER и выдавал
 * «answer/conclusion not delivered» на корректный ответ.
 */
describe("critic: ANSWER не теряется после read-only мутаций", () => {
  it("передаёт текст ответа критику при mutationsSinceCritic > 0", async () => {
    const state = createLoopState();
    state.iteration = 1;
    state.mutationsSinceCritic = 1;

    const criticEvaluate = vi.fn(async () => "pass");
    const auditEvaluate = vi.fn(async () => ({ action: "pass" }));
    const hallucinationEvaluate = vi.fn(async () => ({ action: "accept" }));

    const contextManager = {
      addMessage: vi.fn(),
      getActiveHistory: () => [],
    };
    const logger = { diagnostic: vi.fn() };
    const slog = {
      saveAssistantMessage: vi.fn(),
      logAssistant: vi.fn(),
      logCritic: vi.fn(),
      logRetract: vi.fn(),
      logDiagnosticEvent: vi.fn(),
    };
    const host = {
      contextManager,
      logger,
      hallucinationDetector: { getConsistencyCheck: () => ({ trackDecision: vi.fn() }) },
      config: { session: { autoSave: false }, ui: {} },
      baseDir: process.cwd(),
      onDiagnostic: vi.fn(),
    } as unknown as AgentDeps;

    const inp = {
      state,
      textContent: "ANSWER\nТип: openai-compat, baseUrl: http://host.docker.internal:8080/v1",
      reasoningContent: "",
      input: "show provider config",
      slog,
      hallucinationGate: { evaluate: hallucinationEvaluate },
      criticGate: { evaluate: criticEvaluate },
      auditGate: { evaluate: auditEvaluate },
    } as unknown as GatesInput;

    await runFinalGates(host, inp);

    expect(criticEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        answerText: expect.stringContaining("openai-compat"),
      }),
    );
  });
});
