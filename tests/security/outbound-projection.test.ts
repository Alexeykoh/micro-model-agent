import { describe, expect, it } from "vitest";
import { DEFAULT_DATA_POLICY } from "../../src/modules/security/data-policy/defaults";
import { projectOutboundText } from "../../src/modules/security/data-policy/outbound";
import type { PolicyContext } from "../../src/modules/security/data-policy/context";
import type { DataPolicyConfig } from "../../src/modules/security/data-policy/types";
import { projectSearchQuery } from "../../src/tools/web-search";
import type { ToolContext } from "../../src/tools/types";
import type { AppConfig } from "../../src/config/types";

const ctx: PolicyContext = {
  baseDir: "C:\\work\\proj",
  home: "C:\\Users\\alex",
  hostname: "DESKTOP-ABC123",
  username: "alex",
  env: { USERNAME: "alex", COMPUTERNAME: "DESKTOP-ABC123" },
  workspaceRoots: ["D:\\shared"],
};

const config: DataPolicyConfig = { ...DEFAULT_DATA_POLICY };
const external = { kind: "api" as const, trusted: false };
const trusted = { kind: "api" as const, trusted: true };

const SECRET = "sk-abcdefghij0123456789";
const raw = `open C:\\work\\proj\\src\\a.ts on DESKTOP-ABC123 key=${SECRET}`;

describe("проекция внешнего egress (web_search)", () => {
  it("маскирует путь, хост и секрет для внешней цели", () => {
    const out = projectOutboundText(raw, config, external, ctx);
    expect(out.changed).toBe(true);
    expect(out.text).not.toContain("C:\\work\\proj");
    expect(out.text).not.toContain("DESKTOP-ABC123");
    expect(out.text).not.toContain(SECRET);
    expect(out.text).toContain("[PATH]");
  });

  it("не отдаёт псевдонимы с token id — только метки", () => {
    const out = projectOutboundText(raw, config, external, ctx);
    expect(out.text).not.toMatch(/<[A-Z]+:[^>]+>/);
  });

  it("доверенная цель маскирует только секрет", () => {
    const out = projectOutboundText(raw, config, trusted, ctx);
    expect(out.text).toContain("C:\\work\\proj");
    expect(out.text).not.toContain(SECRET);
  });

  it("выключенная политика возвращает текст как есть", () => {
    const out = projectOutboundText(raw, { ...config, enabled: false }, external, ctx);
    expect(out.text).toBe(raw);
    expect(out.changed).toBe(false);
  });
});

describe("web_search: запрос маскируется до сети", () => {
  function toolCtx(policy: DataPolicyConfig | undefined): ToolContext {
    return {
      config: { security: policy ? { dataPolicy: policy } : {} } as unknown as AppConfig,
      baseDir: "C:\\work\\proj",
    } as ToolContext;
  }

  it("секрет и путь не попадают в поисковый запрос", () => {
    const out = projectSearchQuery(raw, toolCtx(config));
    expect(out).not.toContain("C:\\work\\proj");
    expect(out).not.toContain(SECRET);
  });

  it("без политики запрос уходит как есть (CLI с выключенным DLP)", () => {
    expect(projectSearchQuery(raw, toolCtx(undefined))).toBe(raw);
    expect(projectSearchQuery(raw, toolCtx({ ...config, enabled: false }))).toBe(raw);
  });
});
