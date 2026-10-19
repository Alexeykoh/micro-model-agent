import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/config/types";
import type { PolicyContext } from "../../src/modules/security/data-policy/context";
import { DEFAULT_DATA_POLICY } from "../../src/modules/security/data-policy/defaults";
import { createProviderEgressFactory } from "../../src/modules/security/data-policy/egress-provider";
import { setEgressGuard } from "../../src/modules/providers/sanitizing";
import { contextLogGuard } from "../../src/core/agent/context-egress";

const ctx: PolicyContext = {
  baseDir: "C:\\work\\proj",
  home: "C:\\Users\\alex",
  hostname: "DESKTOP-ABC123",
  username: "alex",
  env: { USERNAME: "alex", COMPUTERNAME: "DESKTOP-ABC123" },
};

const config = {
  provider: {
    type: "openai-compat",
    baseUrl: "https://api.example.com/v1",
    active: "a",
    entries: [{ type: "openai-compat", label: "a", baseUrl: "https://api.example.com/v1" }],
  },
  security: { dataPolicy: DEFAULT_DATA_POLICY },
} as never as AppConfig;

afterEach(() => setEgressGuard(null));

describe("context-log DLP projection (E1)", () => {
  it("snapshot получает токены вместо машинных путей/имени", () => {
    setEgressGuard(createProviderEgressFactory({ getConfig: () => config, ctx }));
    const guard = contextLogGuard(config);
    expect(guard).toBeDefined();
    const result = guard!.sanitizeChat(
      [
        { role: "system", content: "Workspace: C:\\work\\proj. CWD: C:\\work\\proj" },
        { role: "user", content: "open C:\\work\\proj\\src\\a.ts on DESKTOP-ABC123" },
      ],
      [{ name: "read", description: "read C:\\work\\proj\\x", parameters: {} }],
    );
    const json = JSON.stringify({ messages: result.messages, tools: result.tools });
    expect(json).not.toContain("C:\\work\\proj");
    expect(json).not.toContain("DESKTOP-ABC123");
    expect(json).toContain("<PATH:");
  });

  it("без регистрации guard'а snapshot не редактируется", () => {
    expect(contextLogGuard(config)).toBeUndefined();
  });
});
