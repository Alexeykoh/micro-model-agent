import { describe, expect, it } from "bun:test";
import { redactConfigSecrets } from "../../src/config/redact";

describe("redactConfigSecrets", () => {
  it("redacts provider api keys", () => {
    const input = { provider: { type: "openai-compat", apiKey: "sk-secret" } };
    const out = redactConfigSecrets(input) as any;
    expect(out.provider.apiKey).toBe("***");
  });

  it("redacts nested entry api keys", () => {
    const input = {
      provider: { entries: [{ label: "a", apiKey: "k1" }, { label: "b", apiKey: "k2" }] },
    };
    const out = redactConfigSecrets(input) as any;
    expect(out.provider.entries[0].apiKey).toBe("***");
    expect(out.provider.entries[1].apiKey).toBe("***");
  });

  it("redacts mcp header values", () => {
    const input = { mcpServers: { s: { headers: { Authorization: "Bearer x" } } } };
    const out = redactConfigSecrets(input) as any;
    expect(out.mcpServers.s.headers.Authorization).toBe("***");
  });

  it("redacts webhook urls", () => {
    const input = { security: { audit: { webhookUrl: "https://hook/secret" } } };
    const out = redactConfigSecrets(input) as any;
    expect(out.security.audit.webhookUrl).toBe("***");
  });

  it("leaves non-secret values intact", () => {
    const input = { model: "qwen/qwen3.5-9b", contextWindow: 32768, maxTokens: 4096 };
    expect(redactConfigSecrets(input)).toEqual(input);
  });

  it("does not mutate the input", () => {
    const input = { provider: { apiKey: "sk-x" } };
    redactConfigSecrets(input);
    expect((input as any).provider.apiKey).toBe("sk-x");
  });
});
