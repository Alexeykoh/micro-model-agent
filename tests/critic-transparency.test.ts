import { describe, expect, it, vi } from "vitest";
import { CriticClient, type CriticStage } from "../src/modules/critic/client";
import { runCriticChecks } from "../src/modules/critic/tools";
import { CriticGate } from "../src/core/agent/critic-gate";
import { buildCriticReport } from "../src/core/agent/critic-report";
import { createLoopState } from "../src/core/agent/loop-state";
import type { LLMProvider } from "../src/llm/provider";

function scripted(texts: string[], calls: { n: number }): LLMProvider {
  return {
    model: "m",
    contextWindow: 1000,
    countTokens: () => 0,
    listModels: async () => [],
    async *chat() {
      calls.n++;
      yield { type: "text" as const, content: texts[Math.min(calls.n - 1, texts.length - 1)] };
      yield { type: "done" as const };
    },
  };
}

const pack = { task: "t", changedFiles: ["a.ts"], commands: [], toolDigest: "✓ write_file a.ts" };

const firstWithChecks =
  '{"status":"critical","summary":"missing","issues":[{"severity":"critical","claim":"c","problem":"p"}],"checks":[{"tool":"read_file","args":{"path":"a.ts"}}]}';
const finalOk = '{"status":"ok","summary":"verified fine","issues":[]}';

describe("critic transparency", () => {
  it("reports what it checks and skips the extra request pass when checks are already named", async () => {
    const calls = { n: 0 };
    const stages: CriticStage[] = [];
    const client = new CriticClient({ provider: scripted([firstWithChecks, finalOk], calls) });
    const verdict = await client.verify(pack, undefined, {
      runCheck: async () => ({ ok: true, output: "real content" }),
      onStage: (stage) => stages.push(stage),
    });
    expect(verdict?.status).toBe("ok");
    // pass-1 + final; pass-2 ("ask for checks") skipped — the model named them.
    expect(calls.n).toBe(2);
    const checksDone = stages.find((s) => s.results?.length);
    expect(checksDone?.checks?.[0].tool).toBe("read_file");
    expect(stages.some((s) => s.stage === "final" && s.verdict?.status === "ok")).toBe(true);
  });

  it("stops running checks when the turn is aborted", async () => {
    const controller = new AbortController();
    let ran = 0;
    const results = await runCriticChecks(
      [
        { tool: "read_file", args: { path: "a.ts" } },
        { tool: "read_file", args: { path: "b.ts" } },
      ],
      async () => {
        ran++;
        controller.abort();
        return { ok: true, output: "x" };
      },
      controller.signal,
    );
    expect(ran).toBe(1);
    expect(results).toHaveLength(1);
  });

  it("builds a report with the verdict, issues and checks (no raw file bodies)", () => {
    const report = buildCriticReport(
      {
        status: "critical",
        summary: "missing result",
        issues: [
          {
            severity: "critical",
            claim: "no file",
            problem: "a.ts absent",
            evidence: "read_file a.ts",
          },
        ],
      },
      [
        { stage: "verdict", pass: 1, verdict: { status: "critical", summary: "x", issues: [] } },
        {
          stage: "checks",
          pass: 1,
          checks: [{ tool: "read_file", args: { path: "a.ts" } }],
          results: [{ tool: "read_file", ok: true, output: "body" }],
        },
        { stage: "final", pass: 2 },
      ],
      1234,
      false,
    );
    expect(report.status).toBe("critical");
    expect(report.passes).toBe(2);
    expect(report.issues[0].claim).toBe("no file");
    expect(report.checks[0]).toMatchObject({ tool: "read_file", ok: true });
    expect(report.durationMs).toBe(1234);
  });

  it("emits a collapsed critic block (kind: critic) with the verdict", async () => {
    const metas: Array<{ text: string; kind?: string; info?: unknown }> = [];
    const state = createLoopState();
    const gate = new CriticGate({
      enabled: true,
      maxCalls: 4,
      maxRepairCycles: 1,
      verify: async (_pack, _signal, onStage) => {
        onStage?.({ stage: "verdict", pass: 1 });
        return { status: "ok", summary: "fine", issues: [] };
      },
      buildPack: (x: never) => x,
    });
    const action = await gate.evaluate({
      state,
      iteration: 1,
      logger: { diagnostic: vi.fn(), warn: vi.fn(), info: vi.fn() } as never,
      contextManager: { addMessage: vi.fn() } as never,
      slog: { logCritic: vi.fn(), logDiagnosticEvent: vi.fn() } as never,
      task: "t",
      beforeFinish: true,
      toolEvents: [{ tool: "read_file", ok: true, output: "x" }],
      answerText: "готово",
      onMeta: (text, kind, info) => metas.push({ text, kind, info }),
    });
    expect(action).toBe("pass");
    const block = metas.find((m) => m.kind === "critic");
    expect(block).toBeDefined();
    const info = block?.info as { critic?: { status: string } } | undefined;
    expect(info?.critic?.status).toBe("ok");
  });
});
