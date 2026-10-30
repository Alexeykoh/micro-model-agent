/**
 * A11 (P0): DLP не имеет права редактировать идентификаторы тулов.
 * Живой дефект: `mcp__playwright__browser_console_messages` превращалось в
 * `mcp__playwright__browser_<ENV:…>_messages`, потому что `SESSIONNAME=Console`
 * (Windows) — value-based env-находка, а `findAll` регистронезависим. Провайдер
 * отвечал 400: `Invalid 'tools[24].function.name'` (pattern `^[a-zA-Z0-9_-]+`).
 */
import { describe, expect, it } from "vitest";
import { createGuard } from "../../src/modules/security/data-policy/guard";
import { DEFAULT_DATA_POLICY } from "../../src/modules/security/data-policy/defaults";
import type { PolicyContext } from "../../src/modules/security/data-policy/context";
import type {
  DataPolicyConfig,
  GuardDiagnostic,
} from "../../src/modules/security/data-policy/types";
import {
  restoreToolNames,
  TOOL_NAME_RE,
} from "../../src/modules/security/data-policy/project-tools";

const ctx: PolicyContext = {
  baseDir: "C:\\work\\proj",
  home: "C:\\Users\\alex",
  hostname: "DESKTOP-ABC123",
  username: "alex",
  env: { USERNAME: "alex", COMPUTERNAME: "DESKTOP-ABC123", SESSIONNAME: "Console" },
};

const config = (): DataPolicyConfig => ({ ...DEFAULT_DATA_POLICY });

function external(overrides: Partial<DataPolicyConfig> = {}, diags?: GuardDiagnostic[]) {
  return createGuard({
    config: { ...config(), ...overrides },
    target: { kind: "provider", trusted: false, host: "api.openai.com" },
    ctx,
    ...(diags ? { onDiagnostic: (d: GuardDiagnostic) => diags.push(d) } : {}),
  });
}

interface OpenAiTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const SECRET = "sk-abcdefghij0123456789";
const PATH = "C:\\work\\proj";

function openAiTool(name: string, description: string): OpenAiTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: `файл внутри ${PATH}`,
            enum: [`${PATH}\\a.ts`, `${PATH}\\b.ts`],
            pattern: "^[A-Za-z]:\\\\",
            default: `${PATH}\\a.ts`,
            format: "uri",
          },
          mode: { type: "string", const: `${PATH}\\a.ts` },
        },
        required: ["path"],
      },
    },
  };
}

describe("DLP: идентификаторы тулов неприкосновенны", () => {
  it("OpenAI-форма: имя и ключи схемы не меняются, description маскируется", () => {
    const guard = external();
    const tool = openAiTool(
      "browser_console_messages",
      `читает ${PATH}\\logs\\a.log, пароль api_key=${SECRET}`,
    );
    const before = structuredClone(tool);

    const result = guard.sanitizeChat([{ role: "user", content: "hi" }], [tool]);
    const out = result.tools as OpenAiTool[];

    expect(out).toHaveLength(1);
    // 1) Имя и форма не тронуты.
    expect(out[0].function.name).toBe("browser_console_messages");
    expect(TOOL_NAME_RE.test(out[0].function.name)).toBe(true);
    expect(Object.keys(out[0])).toEqual(Object.keys(before));
    expect(Object.keys(out[0].function)).toEqual(Object.keys(before.function));
    const props = out[0].function.parameters.properties as Record<string, unknown>;
    const propsBefore = before.function.parameters.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(Object.keys(propsBefore));

    // 2) Свободный текст замаскирован.
    expect(out[0].function.description).not.toContain(PATH);
    expect(out[0].function.description).not.toContain(SECRET);
    expect(result.changed).toBe(true);

    // 3) Валидаторы схемы не тронуты — иначе значение перестанет соответствовать.
    const pathProp = props.path as Record<string, unknown>;
    const pathPropBefore = propsBefore.path as Record<string, unknown>;
    for (const key of ["enum", "pattern", "default", "format", "type"]) {
      expect(pathProp[key]).toEqual(pathPropBefore[key]);
    }
    expect((props.mode as Record<string, unknown>).const).toBe(`${PATH}\\a.ts`);
    expect(out[0].function.parameters.required).toEqual(["path"]);
  });

  it("живой случай: env-значение `Console` не режет имя MCP-тула", () => {
    const guard = external();
    const tool = { name: "mcp__playwright__browser_console_messages", description: "console" };
    const result = guard.sanitizeChat([{ role: "user", content: "hi" }], [tool]);
    const out = result.tools as Array<{ name: string }>;
    expect(out[0].name).toBe("mcp__playwright__browser_console_messages");
    expect(TOOL_NAME_RE.test(out[0].name)).toBe(true);
  });

  it("плоская форма MMA: имя неизменно, описание маскируется", () => {
    const guard = external();
    const tool = {
      name: "read_file",
      description: `reads ${PATH}\\x.ts`,
      parameters: { type: "object", properties: { path: { type: "string" } } },
    };
    const result = guard.sanitizeChat([{ role: "user", content: "hi" }], [tool]);
    const out = result.tools as (typeof tool)[];
    expect(out[0].name).toBe("read_file");
    expect(out[0].description).not.toContain(PATH);
  });

  it("выключенный движок не трогает tools", () => {
    const guard = external({ enabled: false });
    const tool = openAiTool("browser_console_messages", `${PATH}`);
    const result = guard.sanitizeChat([], [tool]);
    expect(result.tools).toEqual([tool]);
    expect(result.changed).toBe(false);
  });
});

describe("DLP: защитный барьер по имени тула", () => {
  it("restoreToolNames возвращает исходное имя и причину", () => {
    const original = [{ type: "function", function: { name: "good_name", description: "x" } }];
    const broken = [{ type: "function", function: { name: "bad name", description: "x" } }];
    const repaired = restoreToolNames(original, broken);
    const def = repaired.tools[0] as { function: { name: string } };
    expect(def.function.name).toBe("good_name");
    expect(repaired.issues).toHaveLength(1);
    expect(repaired.issues[0]).toContain("tools[0].function.name");
  });

  it("sanitizeChat восстанавливает имя, если проекция его сломала, и пишет диагностику", () => {
    // Геттер отдаёт «сломанное» имя на чтении проекцией и исходное — на
    // защитной проверке: так моделируется будущий регресс проекции без моков.
    let reads = 0;
    const tricky = {
      get name(): string {
        reads += 1;
        return reads === 1 ? "bad name" : "good_name";
      },
      description: "reads C:\\work\\proj\\x",
    };
    const diags: GuardDiagnostic[] = [];
    const guard = external({}, diags);
    const result = guard.sanitizeChat([{ role: "user", content: "hi" }], [tricky]);
    const out = result.tools as Array<{ name: string }>;
    expect(out[0].name).toBe("good_name");
    const integrity = diags.find((d) => d.kind === "tool-name-integrity");
    expect(integrity).toBeDefined();
    expect(integrity?.outcome).toBe("passed");
    expect(integrity?.cause).toContain("name");
  });
});
