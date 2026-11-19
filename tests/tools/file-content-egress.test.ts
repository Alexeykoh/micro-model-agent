import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ToolExecutor } from "../../src/tools/executor";
import { ToolRegistry } from "../../src/tools/registry";
import type { ToolContext, ToolDefinition } from "../../src/tools/types";
import { createGuard } from "../../src/modules/security/data-policy/guard";
import { DEFAULT_DATA_POLICY } from "../../src/modules/security/data-policy/defaults";
import {
  isTaggedFileContent,
  tagFileContent,
} from "../../src/modules/security/data-policy/file-content";
import type { PolicyContext } from "../../src/modules/security/data-policy/context";
import type { DataPolicyConfig } from "../../src/modules/security/data-policy/types";

const ctx: PolicyContext = {
  baseDir: "C:\\work\\proj",
  home: "C:\\Users\\alex",
  hostname: "DESKTOP-ABC123",
  username: "alex",
  env: {},
};

const cfg = (over: Partial<DataPolicyConfig> = {}): DataPolicyConfig => ({
  ...DEFAULT_DATA_POLICY,
  providerBlockGlobs: ["secret/"],
  ...over,
});

describe("file-content: ToolExecutor tagging (§4.8)", () => {
  let baseDir: string;
  let registry: ToolRegistry;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "mma-file-content-"));
    registry = new ToolRegistry();
  });
  afterEach(() => rmSync(baseDir, { recursive: true, force: true }));

  function executor(dataPolicy?: DataPolicyConfig): ToolExecutor {
    const context = {
      config: {
        security: {
          paths: { enabled: false, denied: [], allowed: [] },
          ...(dataPolicy ? { dataPolicy } : {}),
        },
      },
      baseDir,
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        logToolCall: vi.fn(),
        logToolOutput: vi.fn(),
      },
    } as unknown as ToolContext;
    return new ToolExecutor(registry, context, { getAllPlugins: () => [] });
  }

  function register(): void {
    const def: ToolDefinition = {
      name: "read",
      description: "d",
      parameters: { type: "object", properties: {} },
      security: { caps: [{ fs: "read" }], pathArgs: ["path"] },
      handler: async () => ({ success: true, output: "TOP SECRET" }),
    };
    registry.register(def, "core");
  }

  it("тегирует результат чтения пути под providerBlockGlobs", async () => {
    register();
    const result = await executor(cfg()).execute({
      id: "1",
      name: "read",
      arguments: { path: "secret/a.txt" },
    });
    expect(result.success).toBe(true);
    expect(isTaggedFileContent(result.output)).toBe(true);
  });

  it("не тегирует обычный путь", async () => {
    register();
    const result = await executor(cfg()).execute({
      id: "1",
      name: "read",
      arguments: { path: "public/a.txt" },
    });
    expect(isTaggedFileContent(result.output)).toBe(false);
  });

  it("kill-switch отключает тегирование", async () => {
    register();
    const result = await executor(cfg({ enabled: false })).execute({
      id: "1",
      name: "read",
      arguments: { path: "secret/a.txt" },
    });
    expect(isTaggedFileContent(result.output)).toBe(false);
  });
});

describe("file-content: egress guard (§4.8)", () => {
  const tagged = tagFileContent("TOP SECRET");
  const external = createGuard({
    config: cfg(),
    target: { kind: "provider", trusted: false, host: "api.openai.com" },
    ctx,
  });
  const local = createGuard({
    config: cfg(),
    target: { kind: "provider", trusted: true, host: "localhost" },
    ctx,
  });

  it("внешнему — маска вместо содержимого, независимо от PII", () => {
    const out = external.sanitizeChat([{ role: "tool", content: tagged }]);
    expect((out.messages[0] as { content: string }).content).toBe("[FILE]");
  });

  it("локальному — оригинал без служебного тега", () => {
    const out = local.sanitizeChat([{ role: "tool", content: tagged }]);
    expect((out.messages[0] as { content: string }).content).toBe("TOP SECRET");
  });

  it("E2 filterClient тоже режет file-content", () => {
    expect(external.filterClient({ output: tagged })).toEqual({ output: "[FILE]" });
  });

  it("egress.fileContent=false отключает блокировку", () => {
    const off = createGuard({
      config: cfg({ egress: { ...cfg().egress, fileContent: false } }),
      target: { kind: "provider", trusted: false, host: "api.openai.com" },
      ctx,
    });
    const out = off.sanitizeChat([{ role: "tool", content: tagged }]);
    expect((out.messages[0] as { content: string }).content).toBe("TOP SECRET");
  });
});
