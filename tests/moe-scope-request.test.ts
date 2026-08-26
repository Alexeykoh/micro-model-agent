import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULTS } from "../src/config/defaults";
import type { MoEPlan } from "../src/modules/execution/types";
import {
  ScopeDenialCollector,
  formatScopeRequest,
  parseScopeRequest,
  isPathDenialOutput,
} from "../src/tools/scope-request";
import { MoEExecutor } from "../src/modules/execution/moe-executor";
import { OrchestratorClient } from "../src/llm/orchestrator";
import { ToolRegistry } from "../src/tools/registry";
import type { ToolDefinition } from "../src/tools/types";
import type { LLMProvider } from "../src/llm/provider";
import type { AppConfig } from "../src/config/types";

function makeConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULTS)) as AppConfig;
}

describe("scope-request protocol primitives", () => {
  it("round-trips format/parse", () => {
    const text = `some answer\n${formatScopeRequest({
      files: ["src/extra.ts"],
      read_only: true,
      reason: "need to read config",
    })}`;
    const parsed = parseScopeRequest(text);
    expect(parsed).toEqual({
      files: ["src/extra.ts"],
      read_only: true,
      reason: "need to read config",
    });
  });

  it("returns null when no scope-request block present", () => {
    expect(parseScopeRequest("plain failure")).toBeNull();
    expect(parseScopeRequest("")).toBeNull();
  });

  it("detects path denial outputs in en and ru", () => {
    expect(isPathDenialOutput("Path not allowed: src/x.ts — outside scope")).toBe(true);
    expect(isPathDenialOutput("Путь недопустим: src/x.ts")).toBe(true);
    expect(isPathDenialOutput("[SCOPE] Path not allowed")).toBe(true);
    expect(isPathDenialOutput("file written successfully")).toBe(false);
  });
});

describe("ScopeDenialCollector plugin", () => {
  it("collects write denials from failed write tools", () => {
    const collector = new ScopeDenialCollector();
    collector.plugin.onAfterTool!(
      {} as any,
      { name: "write_file", arguments: { path: "src/denied.ts" } } as any,
      { success: false, output: "Path not allowed: src/denied.ts" },
    );
    collector.plugin.onAfterTool!(
      {} as any,
      { name: "write_file", arguments: { path: "src/ok.ts" } } as any,
      { success: true, output: "written" },
    );
    collector.plugin.onAfterTool!(
      {} as any,
      { name: "bash", arguments: { command: "boom" } } as any,
      { success: false, output: "[SECURITY BLOCKED] Command is not allowed: rm" },
    );

    const denials = collector.getDenied();
    expect(denials).toHaveLength(1);
    expect(denials[0]).toEqual({ path: "src/denied.ts", write: true });
  });

  it("classifies read-only denials and mixes escalate to write", () => {
    const collector = new ScopeDenialCollector();
    collector.plugin.onAfterTool!(
      {} as any,
      { name: "read_file", arguments: { path: "cfg.json" } } as any,
      { success: false, output: "Path not allowed: cfg.json" },
    );
    expect(collector.getDenied()).toEqual([{ path: "cfg.json", write: false }]);

    collector.plugin.onAfterTool!(
      {} as any,
      { name: "edit_file", arguments: { path: "cfg.json" } } as any,
      { success: false, output: "Path not allowed: cfg.json" },
    );
    expect(collector.getDenied()).toEqual([{ path: "cfg.json", write: true }]);
  });

  it("ignores non-denial failures", () => {
    const collector = new ScopeDenialCollector();
    collector.plugin.onAfterTool!(
      {} as any,
      { name: "write_file", arguments: { path: "a.ts" } } as any,
      { success: false, output: "TypeError: cannot write" },
    );
    expect(collector.getDenied()).toHaveLength(0);
  });
});

function sub(id: string, extra: Partial<MoEPlan["subtasks"][number]> = {}): MoEPlan["subtasks"][number] {
  return {
    id,
    description: `do ${id}`,
    expert_tag: "code",
    allowed_files: [],
    read_only_files: [],
    depends_on: [],
    input_from: [],
    expected_output: "",
    success_criteria: [],
    ...extra,
  };
}

function makeExecutor(
  subagentHandler: any,
  onScopeRequest?: any,
): MoEExecutor {
  const registry = new ToolRegistry();
  const mockSubagentTool: ToolDefinition = {
    name: "subagent",
    description: "Mock subagent",
    parameters: { type: "object", properties: {} },
    tags: ["code"],
    handler: subagentHandler,
  };
  registry.register(mockSubagentTool);
  return new MoEExecutor({
    config: makeConfig(),
    toolRegistry: registry,
    toolExecutor: {} as any,
    llmProvider: {} as any,
    logger: { debug: () => {}, warn: () => {}, info: () => {} } as any,
    baseDir: "/tmp/moe-scope-test",
    onScopeRequest,
  });
}

const SCOPE_FAIL = {
  success: false,
  output:
    'Sub-agent failed: blocked\nPartial output: I could not write the file.\n<scope-request>{"files":["src/extra.ts"],"read_only":false,"reason":"must edit extra.ts"}</scope-request>',
};

describe("MoEExecutor scope_request handling", () => {
  let calls: any[];

  beforeEach(() => {
    calls = [];
  });

  function handlerScript(steps: Array<{ success: boolean; output: string }>) {
    return vi.fn().mockImplementation(async (_ctx: any, args: any) => {
      calls.push(args);
      return steps[Math.min(calls.length - 1, steps.length - 1)];
    });
  }

  it("re-executes the subtask with an approved expanded scope", async () => {
    const executor = makeExecutor(
      handlerScript([
        SCOPE_FAIL,
        { success: true, output: "Sub-agent completed:\ndone with extra.ts" },
      ]),
      async () => ({ action: "approve", write: ["src/extra.ts"], read: [] }),
    );
    const result = await executor.executePlan({
      title: "t",
      subtasks: [sub("a")],
      shared_context: { rules: [], refs: [] },
    });

    expect(calls).toHaveLength(2);
    expect(result.success).toBe(true);
    expect(calls[1].allowed_files).toContain("src/extra.ts");
  });

  it("marks the subtask failed when the router rejects", async () => {
    const executor = makeExecutor(handlerScript([SCOPE_FAIL]), async () => ({
      action: "reject",
    }));
    const result = await executor.executePlan({
      title: "t",
      subtasks: [sub("a")],
      shared_context: { rules: [], refs: [] },
    });

    expect(calls).toHaveLength(1);
    expect(result.success).toBe(false);
    expect(result.results[0].error).toContain("scope");
  });

  it("caps scope expansion at 2 cycles then fails honestly", async () => {
    const executor = makeExecutor(
      handlerScript([SCOPE_FAIL]),
      async () => ({ action: "approve", write: [`f${calls.length}.ts`], read: [] }),
    );
    const result = await executor.executePlan({
      title: "t",
      subtasks: [sub("a")],
      shared_context: { rules: [], refs: [] },
    });

    // initial + 2 approved retries, each retry hits the same denial
    expect(calls).toHaveLength(3);
    expect(result.success).toBe(false);
  });

  it("does not engage the router for plain failures without a scope block", async () => {
    const router = async () => ({ action: "approve", write: ["x"], read: [] });
    const executor = makeExecutor(
      handlerScript([{ success: false, output: "Sub-agent failed: syntax error" }]),
      router,
    );
    const result = await executor.executePlan({
      title: "t",
      subtasks: [sub("a")],
      shared_context: { rules: [], refs: [] },
    });

    expect(calls).toHaveLength(1);
    expect(result.success).toBe(false);
  });

  it("works without onScopeRequest (backward compatible)", async () => {
    const executor = makeExecutor(handlerScript([SCOPE_FAIL]));
    const result = await executor.executePlan({
      title: "t",
      subtasks: [sub("a")],
      shared_context: { rules: [], refs: [] },
    });

    expect(calls).toHaveLength(1);
    expect(result.success).toBe(false);
  });
});

function providerReturning(json: string): LLMProvider {
  return {
    chat: async function* () {
      yield { type: "text", content: json };
    },
    countTokens: async () => 10,
  } as unknown as LLMProvider;
}

describe("OrchestratorClient.resolveScopeRequest", () => {
  const req = { files: ["src/a.ts"], read_only: false, reason: "need write" };

  it("parses an approve decision", async () => {
    const client = new OrchestratorClient(
      { model: "test" },
      providerReturning(
        '{"action":"approve","write":["src/a.ts"],"read":["docs/x.md"]}',
      ),
    );
    const decision = await client.resolveScopeRequest!("req-1", req);
    expect(decision.action).toBe("approve");
    if (decision.action === "approve") {
      expect(decision.write).toContain("src/a.ts");
      expect(decision.read).toContain("docs/x.md");
    }
  });

  it("defaults to reject on unparseable output", async () => {
    const client = new OrchestratorClient({ model: "test" }, providerReturning("I don't know"));
    const decision = await client.resolveScopeRequest!("req-1", req);
    expect(decision.action).toBe("reject");
  });
});
