import { describe, it, expect } from "vitest";
import { pipelineRunTool } from "../../src/tools/pipeline-run";

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    config: {
      contextWindow: 64000,
      contextBudget: {},
      session: {},
    },
    baseDir: process.cwd(),
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    llmProvider: { chat: async () => {}, countTokens: () => 1 },
    toolExecutor: {
      getToolDefinitions: () => [],
    },
    recursionDepth: 0,
    ...overrides,
  };
}

describe("pipelineRunTool", () => {
  it("has correct definition", () => {
    expect(pipelineRunTool.name).toBe("pipeline_run");
    expect(pipelineRunTool.description).toBeTruthy();
    expect(pipelineRunTool.parameters.required).toContain("name");
    expect(pipelineRunTool.parameters.required).toContain("yaml");
    const props = pipelineRunTool.parameters.properties as Record<string, any>;
    expect(props.name).toBeDefined();
    expect(props.yaml).toBeDefined();
  });

  it("parses valid pipeline YAML", async () => {
    const yaml = `
name: test-pipeline
steps:
  - id: step1
    agent: default
    prompt: Do something
  - id: step2
    agent: default
    prompt: Do another thing
    depends_on:
      - step1
`;
    const result = await pipelineRunTool.handler(makeCtx(), {
      name: "test-pipeline",
      yaml,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("test-pipeline");
  });

  it("fails on invalid YAML", async () => {
    const result = await pipelineRunTool.handler(makeCtx(), {
      name: "bad-pipeline",
      yaml: "invalid: yaml",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("error");
  });

  it("fails on empty YAML", async () => {
    const result = await pipelineRunTool.handler(makeCtx(), {
      name: "empty",
      yaml: "",
    });

    expect(result.success).toBe(false);
  });

  it("rejects when llmProvider or toolExecutor is missing", async () => {
    const result = await pipelineRunTool.handler(
      { config: {}, baseDir: process.cwd(), logger: {} } as any,
      {
        name: "no-deps",
        yaml: "name: no-deps\nsteps:\n  - id: s1\n    agent: default\n    prompt: hi",
      },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("cannot run");
  });
});
