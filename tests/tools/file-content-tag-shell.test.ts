import { describe, expect, it } from "vitest";
import { tagShellFileContent } from "../../src/tools/file-content-tag";
import { isTaggedFileContent } from "../../src/modules/security/data-policy/file-content";
import { DEFAULT_DATA_POLICY } from "../../src/modules/security/data-policy/defaults";
import type { DataPolicyConfig } from "../../src/modules/security/data-policy/types";
import type { ToolContext } from "../../src/tools/types";
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

const bash = { name: "bash" } as RegisteredTool;
const other = { name: "web_search" } as RegisteredTool;
const output = { success: true, output: "TOPSECRET-CONTENT" };

function run(
  command: string,
  tool: RegisteredTool = bash,
  dp: DataPolicyConfig = policy,
): { tagged: boolean; output: string } {
  const call = { id: "c1", name: tool.name, arguments: { command } };
  const res = tagShellFileContent(tool, call as never, output, ctx(dp));
  return { tagged: isTaggedFileContent(res.output), output: res.output };
}

describe("bash как источник file-content", () => {
  it("команда с путём под block-glob тегирует весь вывод", () => {
    expect(run("cat secret/.env").tagged).toBe(true);
    expect(run("type .\\secret\\a.txt").tagged).toBe(true);
    expect(run("Get-Content -Raw secret\\notes.md").tagged).toBe(true);
  });

  it("обычная команда не тегируется", () => {
    expect(run("echo hello").tagged).toBe(false);
    expect(run("git status").tagged).toBe(false);
    expect(run("cat README.md").tagged).toBe(false);
  });

  it("флаги не считаются путями", () => {
    expect(run("ls --color=auto -la").tagged).toBe(false);
  });

  it("переменные окружения и ~ раскрываются для проверки пути", () => {
    process.env.MMA_TEST_SECRET_DIR = "C:\\work\\proj\\secret";
    try {
      expect(run("cat $MMA_TEST_SECRET_DIR/a.txt").tagged).toBe(true);
      expect(run("cat ${MMA_TEST_SECRET_DIR}/a.txt").tagged).toBe(true);
      expect(run("type %MMA_TEST_SECRET_DIR%\\a.txt").tagged).toBe(true);
    } finally {
      delete process.env.MMA_TEST_SECRET_DIR;
    }
    // `~` раскрывается в домашний каталог; .env* под block-glob.
    expect(run("cat ~/.env").tagged).toBe(true);
  });

  it("другие тулы не трогает", () => {
    expect(run("cat secret/.env", other).tagged).toBe(false);
  });

  it("выключенная политика ничего не тегирует", () => {
    expect(run("cat secret/.env", bash, { ...policy, enabled: false }).tagged).toBe(false);
  });

  it("пустой вывод и неуспех не тегируются", () => {
    const call = { id: "c1", name: "bash", arguments: { command: "cat secret/.env" } };
    expect(
      isTaggedFileContent(tagShellFileContent(bash, call as never, { success: false, output: "x" }, ctx()).output),
    ).toBe(false);
    expect(
      isTaggedFileContent(tagShellFileContent(bash, call as never, { success: true, output: "" }, ctx()).output),
    ).toBe(false);
  });
});
