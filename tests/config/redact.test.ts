import { describe, expect, it } from "bun:test";
import { redactConfigSecrets, serializeConfigForWire } from "../../src/config/redact";

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
    const input = { security: { auditNotifier: { webhookUrl: "https://hook/secret" } } };
    const out = redactConfigSecrets(input) as any;
    expect(out.security.auditNotifier.webhookUrl).toBe("***");
  });

  it("redacts env map values", () => {
    const input = { mcpServers: { s: { env: { API_TOKEN: "abc", PLAIN: "x" } } } };
    const out = redactConfigSecrets(input) as any;
    expect(out.mcpServers.s.env.API_TOKEN).toBe("***");
    expect(out.mcpServers.s.env.PLAIN).toBe("***");
  });

  it("redacts string elements of a secret-keyed array", () => {
    const input = { provider: { tokens: ["a", "b"] } };
    const out = redactConfigSecrets(input) as any;
    expect(out.provider.tokens).toEqual(["***", "***"]);
  });

  it("passes RegExp values through untouched", () => {
    const re = /dangerous/gi;
    const input = { security: { contentScan: { dangerousPatterns: [re] } } };
    const out = redactConfigSecrets(input) as any;
    expect(out.security.contentScan.dangerousPatterns[0]).toBe(re);
  });

  it("leaves non-secret values intact", () => {
    const input = { model: "qwen/qwen3.5-9b", contextWindow: 32768, maxTokens: 4096 };
    expect(redactConfigSecrets(input)).toEqual(input);
  });

  it("does not mutate the input and returns a distinct copy", () => {
    const input = { provider: { apiKey: "sk-x", entries: [{ apiKey: "y" }] } };
    const out = redactConfigSecrets(input) as any;
    expect(out).not.toBe(input);
    expect(out.provider).not.toBe((input as any).provider);
    expect(out.provider.entries).not.toBe((input as any).provider.entries);
    expect((input as any).provider.apiKey).toBe("sk-x");
  });
});

describe("serializeConfigForWire", () => {
  it("turns RegExp into its source so JSON keeps the pattern", () => {
    const input = { security: { contentScan: { dangerousPatterns: [/eval\(/g, /rm -rf/] } } };
    const out = serializeConfigForWire(input) as any;
    expect(out.security.contentScan.dangerousPatterns).toEqual(["eval\\(", "rm -rf"]);
    expect(JSON.parse(JSON.stringify(out)).security.contentScan.dangerousPatterns).toEqual([
      "eval\\(",
      "rm -rf",
    ]);
    expect(input.security.contentScan.dangerousPatterns[0]).toBeInstanceOf(RegExp);
  });

  it("still redacts secrets", () => {
    const input = { provider: { apiKey: "sk-secret" } };
    expect((serializeConfigForWire(input) as any).provider.apiKey).toBe("***");
  });
});
