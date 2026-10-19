import { describe, expect, it } from "vitest";
import { buildSystemInfo } from "../../src/core/system-prompt";
import type { PolicyContext } from "../../src/modules/security/data-policy/context";
import { createGuard } from "../../src/modules/security/data-policy/guard";
import { DEFAULT_DATA_POLICY } from "../../src/modules/security/data-policy/defaults";

/**
 * R17: реальные источники промпта (systemInfo с `Workspace`/`CWD`, блок памяти,
 * описания тулов) не должны отдавать внешнему провайдеру машинные пути и имя.
 */
const baseDir = "C:\\work\\proj";
const ctx: PolicyContext = {
  baseDir,
  home: "C:\\Users\\alex",
  hostname: "DESKTOP-ABC123",
  username: "alex",
  env: { USERNAME: "alex", COMPUTERNAME: "DESKTOP-ABC123" },
};

const externalGuard = () =>
  createGuard({
    config: DEFAULT_DATA_POLICY,
    target: { kind: "provider", trusted: false, host: "api.openai.com" },
    ctx,
  });

describe("prompt sources egress (R17)", () => {
  it("systemInfo с Workspace/CWD + память + описания тулов очищаются", () => {
    const systemInfo = buildSystemInfo({ model: "test-model" } as never, baseDir, "win32 shell=cmd");
    // Источник реально несёт машинные данные — иначе тест ничего не проверяет.
    expect(systemInfo).toContain(baseDir);

    const memory = "MEMORY: user C:\\Users\\alex works on DESKTOP-ABC123";
    const tools = [
      {
        name: "read",
        description: "read a file under C:\\work\\proj",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "e.g. C:\\work\\proj\\src\\a.ts" } },
        },
      },
    ];

    const result = externalGuard().sanitizeChat(
      [
        { role: "system", content: systemInfo },
        { role: "system", content: memory },
        { role: "user", content: "hi" },
      ],
      tools,
    );
    const json = JSON.stringify({ messages: result.messages, tools: result.tools });
    expect(json).not.toContain(baseDir);
    expect(json).not.toContain("DESKTOP-ABC123");
    expect(json).not.toContain("C:\\Users\\alex");
    expect(result.changed).toBe(true);
  });
});
