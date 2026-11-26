import { describe, expect, it } from "vitest";
import {
  tagBlockedFileContent,
  tagShellFileContent,
  tagUndeclaredPluginRead,
} from "../../src/tools/file-content-tag";
import { isTaggedFileContent } from "../../src/modules/security/data-policy/file-content";
import { DEFAULT_DATA_POLICY } from "../../src/modules/security/data-policy/defaults";
import type { DataPolicyConfig } from "../../src/modules/security/data-policy/types";
import type { ToolCall, ToolContext, ToolResult } from "../../src/tools/types";
import type { RegisteredTool } from "../../src/tools/registry";

const policy: DataPolicyConfig = {
  ...DEFAULT_DATA_POLICY,
  providerBlockGlobs: ["secret/**", ".env*"],
};

function ctx(dp: DataPolicyConfig = policy): ToolContext {
  return {
    config: { security: { dataPolicy: dp } },
    baseDir: "C:\\work\\proj",
  } as unknown as ToolContext;
}

function pluginTool(security: Record<string, unknown>): RegisteredTool {
  return {
    name: "plugin__demo__scan",
    tags: ["plugin:demo"],
    security,
  } as unknown as RegisteredTool;
}

const output = { success: true, output: "TOPSECRET-CONTENT" };

type Tagger = (
  tool: RegisteredTool,
  call: ToolCall,
  result: ToolResult,
  ctx: ToolContext,
) => ToolResult;

function tagged(
  fn: Tagger,
  tool: RegisteredTool,
  args: Record<string, unknown> = {},
  dp: DataPolicyConfig = policy,
  result = output,
): boolean {
  const call = { id: "c1", name: tool.name, arguments: args } as never;
  return isTaggedFileContent(fn(tool, call, result, ctx(dp)).output);
}

describe("плагин без pathArgs: fail-closed taint", () => {
  it("OUTPUT плагина с fs:read без pathArgs помечается file-content", () => {
    const tool = pluginTool({ caps: [{ fs: "read" }] });
    const result = tagUndeclaredPluginRead(tool, output, ctx());
    expect(result.success).toBe(true);
    expect(isTaggedFileContent(result.output)).toBe(true);
  });

  it("плагин с объявленным pathArgs проверяется по значению аргумента", () => {
    const tool = pluginTool({ caps: [{ fs: "read" }], pathArgs: ["path"] });
    expect(tagged(tagBlockedFileContent, tool, { path: "secret/.env" })).toBe(true);
    expect(tagged(tagBlockedFileContent, tool, { path: "README.md" })).toBe(false);
    expect(isTaggedFileContent(tagUndeclaredPluginRead(tool, output, ctx()).output)).toBe(false);
  });

  it("плагин без чтения и не-плагин не трогаются", () => {
    const writeOnly = pluginTool({ caps: [{ fs: "write" }] });
    expect(isTaggedFileContent(tagUndeclaredPluginRead(writeOnly, output, ctx()).output)).toBe(false);
    const core = { name: "glob", security: { caps: [{ fs: "read" }] } } as unknown as RegisteredTool;
    expect(isTaggedFileContent(tagUndeclaredPluginRead(core, output, ctx()).output)).toBe(false);
  });

  it("выключенная политика и неуспешный/пустой вывод не тегируются", () => {
    const tool = pluginTool({ caps: [{ fs: "read" }] });
    expect(isTaggedFileContent(tagUndeclaredPluginRead(tool, output, ctx({ ...policy, enabled: false })).output)).toBe(false);
    expect(isTaggedFileContent(tagUndeclaredPluginRead(tool, { success: false, output: "x" }, ctx()).output)).toBe(false);
    expect(isTaggedFileContent(tagUndeclaredPluginRead(tool, { success: true, output: "" }, ctx()).output)).toBe(false);
  });

  it("подстановка bash с путём под block-glob тегирует вывод", () => {
    const bash = { name: "bash" } as unknown as RegisteredTool;
    expect(tagged(tagShellFileContent, bash, { command: "echo $(cat secret/.env)" })).toBe(true);
  });
});
