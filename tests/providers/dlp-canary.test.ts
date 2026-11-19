/**
 * Сквозной гейт: canary-строка не должна доходить до «провайдера» ни в одном
 * представлении. Проверяем не guard напрямую, а `SanitizingProvider` — тот шов,
 * через который проходит каждый LLM-вызов.
 */
import { describe, expect, it } from "vitest";
import { SanitizingProvider } from "../../src/modules/providers/sanitizing";
import type { LLMProvider, Message } from "../../src/llm/provider";
import { createGuard } from "../../src/modules/security/data-policy/guard";
import { DEFAULT_DATA_POLICY } from "../../src/modules/security/data-policy/defaults";
import type { PolicyContext } from "../../src/modules/security/data-policy/context";
import type { DataPolicyConfig } from "../../src/modules/security/data-policy/types";

const BASE = "C:\\work\\proj";
const CANARY = "CANARY4c1d2e";
const PATH = `${BASE}\\secret\\${CANARY}.txt`;

const ctx: PolicyContext = {
  baseDir: BASE,
  home: "C:\\Users\\alex",
  hostname: "DESKTOP-ABC123",
  username: "alex",
  workspaceRoots: [],
};

const config: DataPolicyConfig = {
  ...DEFAULT_DATA_POLICY,
  pseudonymize: false,
  pathMode: "prefix",
  providerBlockGlobs: ["secret/**"],
};

/** Провайдер-шпион: запоминает, что реально до него дошло. */
function spyProvider(): { provider: LLMProvider; captured: () => string } {
  let seen: Message[] = [];
  const provider = {
    model: "spy",
    contextWindow: 1000,
    countTokens: () => 0,
    listModels: async () => [],
    chat: async function* (messages: Message[]) {
      seen = messages;
    },
  } as unknown as LLMProvider;
  return { provider, captured: () => JSON.stringify(seen) };
}

async function passThrough(text: string): Promise<string> {
  const { provider, captured } = spyProvider();
  const guard = createGuard({
    config,
    target: { kind: "provider", trusted: false, host: "api.example.com" },
    ctx,
  });
  const wrapped = new SanitizingProvider(provider, guard);
  for await (const _chunk of wrapped.chat([{ role: "user", content: text }])) {
    /* шпион ничего не отдаёт */
  }
  return captured();
}

describe("canary не доходит до провайдера (E1 end-to-end)", () => {
  const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
  const variants: Array<[string, string]> = [
    ["raw", PATH],
    ["base64", b64(PATH)],
    ["hex", Buffer.from(PATH, "utf8").toString("hex")],
    ["percent", encodeURIComponent(PATH)],
    ["split", `${BASE.slice(0, 8)} + "${BASE.slice(8)}\\secret\\${CANARY}.txt"`],
    ["fence", "```\n" + PATH + "\n```"],
  ];

  for (const [name, text] of variants) {
    it(`не пропускает: ${name}`, async () => {
      const body = await passThrough(text);
      expect(body).not.toContain(CANARY);
    });
  }
});
