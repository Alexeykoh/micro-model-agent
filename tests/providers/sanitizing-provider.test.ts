import { afterEach, describe, expect, it } from "vitest";
import type { ChatOptions, Chunk, LLMProvider, Message, ToolDefinition } from "../../src/llm/provider";
import type { PolicyContext } from "../../src/modules/security/data-policy/context";
import { createGuard } from "../../src/modules/security/data-policy/guard";
import { DEFAULT_DATA_POLICY } from "../../src/modules/security/data-policy/defaults";
import { tagFileContent } from "../../src/modules/security/data-policy/file-content";
import {
  SanitizingProvider,
  setEgressGuard,
  type ProviderEgressGuard,
} from "../../src/modules/providers/sanitizing";
import { buildActiveProvider } from "../../src/modules/providers/factory";
import { buildManagedProvider } from "../../src/modules/providers/managed";

const ctx: PolicyContext = {
  baseDir: "C:\\work\\proj",
  home: "C:\\Users\\alex",
  hostname: "DESKTOP-ABC123",
  username: "alex",
  env: { USERNAME: "alex", COMPUTERNAME: "DESKTOP-ABC123" },
};

const external = () =>
  createGuard({
    config: DEFAULT_DATA_POLICY,
    target: { kind: "provider", trusted: false, host: "api.openai.com" },
    ctx,
  });
const loopback = () =>
  createGuard({
    config: DEFAULT_DATA_POLICY,
    target: { kind: "provider", trusted: true, host: "localhost" },
    ctx,
  });

/** Фейковый провайдер: запоминает отправленные сообщения и отдаёт скрипт чанков. */
class FakeProvider implements LLMProvider {
  readonly model = "fake-model";
  readonly contextWindow = 8192;
  seen?: Message[];
  seenTools?: ToolDefinition[];

  constructor(private readonly script: (seen: Message[]) => Chunk[] = () => [{ type: "done" }]) {}

  countTokens(): number {
    return 1;
  }

  async listModels(): Promise<string[]> {
    return ["fake-model"];
  }

  async *chat(
    messages: Message[],
    tools?: ToolDefinition[],
    _signal?: AbortSignal,
    _options?: ChatOptions,
  ): AsyncIterable<Chunk> {
    this.seen = messages;
    this.seenTools = tools;
    for (const chunk of this.script(messages)) yield chunk;
  }
}

async function collect(iterable: AsyncIterable<Chunk>): Promise<Chunk[]> {
  const out: Chunk[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

afterEach(() => setEgressGuard(null));

describe("SanitizingProvider (E1)", () => {
  it("внешнему не уходят baseDir/hostname, уходят токены", async () => {
    const inner = new FakeProvider();
    const provider = new SanitizingProvider(inner, external());
    await collect(
      provider.chat([{ role: "user", content: "open C:\\work\\proj\\src\\a.ts on DESKTOP-ABC123" }]),
    );
    const json = JSON.stringify(inner.seen);
    expect(json).not.toContain("C:\\work\\proj");
    expect(json).not.toContain("DESKTOP-ABC123");
    expect(json).toContain("<PATH:");
  });

  it("loopback-провайдеру пути остаются (локальная работа)", async () => {
    const inner = new FakeProvider();
    const provider = new SanitizingProvider(inner, loopback());
    await collect(provider.chat([{ role: "user", content: "open C:\\work\\proj\\src\\a.ts" }]));
    expect(String(inner.seen?.[0]?.content)).toContain("C:\\work\\proj\\src\\a.ts");
  });

  it("санитизирует и определения тулов", async () => {
    const inner = new FakeProvider();
    const provider = new SanitizingProvider(inner, external());
    await collect(
      provider.chat(
        [{ role: "user", content: "hi" }],
        [{ name: "read", description: "reads C:\\work\\proj\\x", parameters: { type: "object" } }],
      ),
    );
    expect(JSON.stringify(inner.seenTools)).not.toContain("C:\\work\\proj");
  });

  it("ре-гидратирует аргументы тула JSON-safe (backslash не ломает JSON)", async () => {
    // baseDir = весь путь: value-based finding покрывает его целиком (prefix-режим
    // иначе заменил бы только корень и сохранил остаток).
    const fullCtx: PolicyContext = { ...ctx, baseDir: "C:\\work\\proj\\src\\a.ts" };
    const guard = createGuard({
      config: DEFAULT_DATA_POLICY,
      target: { kind: "provider", trusted: false, host: "api.openai.com" },
      ctx: fullCtx,
    });
    const inner = new FakeProvider((seen) => {
      const token = String(seen[0].content).match(/<PATH:[0-9a-f]+>/)?.[0] ?? "";
      return [
        {
          type: "tool_call",
          toolCall: { id: "1", name: "read", arguments: JSON.stringify({ path: token }) },
        },
        { type: "done" },
      ];
    });
    const provider = new SanitizingProvider(inner, guard);
    const chunks = await collect(
      provider.chat([{ role: "user", content: "open C:\\work\\proj\\src\\a.ts" }]),
    );
    const call = chunks.find((c) => c.type === "tool_call");
    expect(call?.toolCall).toBeDefined();
    const args = JSON.parse(call!.toolCall!.arguments) as { path: string };
    expect(args.path).toBe("C:\\work\\proj\\src\\a.ts");
  });

  it("чужой токен остаётся как есть (ре-гидратация только по своей карте)", async () => {
    const inner = new FakeProvider(() => [
      { type: "tool_call", toolCall: { id: "1", name: "read", arguments: '{"path":"<PATH:deadbeef>"}' } },
      { type: "done" },
    ]);
    const provider = new SanitizingProvider(inner, external());
    const chunks = await collect(provider.chat([{ role: "user", content: "hi" }]));
    const call = chunks.find((c) => c.type === "tool_call");
    expect(call!.toolCall!.arguments).toBe('{"path":"<PATH:deadbeef>"}');
  });

  it("image-части вырезаются для внешнего без allowImagesToExternal", async () => {
    const inner = new FakeProvider();
    const provider = new SanitizingProvider(inner, external());
    await collect(
      provider.chat([
        {
          role: "user",
          content: [
            { type: "text", text: "see this" },
            { type: "image_url", image_url: { url: "C:\\work\\proj\\secret.png" } },
          ],
        },
      ]),
    );
    const json = JSON.stringify(inner.seen);
    expect(json).not.toContain("image_url");
    expect(json).not.toContain("secret.png");
    expect(json).toContain("see this");
  });

  it("image-части остаются доверенному провайдеру", async () => {
    const inner = new FakeProvider();
    const provider = new SanitizingProvider(inner, loopback());
    await collect(
      provider.chat([
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "http://img.local/a.png" } }],
        },
      ]),
    );
    expect(JSON.stringify(inner.seen)).toContain("image_url");
  });

  it("file-content из-block пути: внешнему [FILE], локальному — оригинал", async () => {
    const tagged = tagFileContent("TOP SECRET");
    const remote = new FakeProvider();
    await collect(new SanitizingProvider(remote, external()).chat([{ role: "tool", content: tagged }]));
    const remoteJson = JSON.stringify(remote.seen);
    expect(remoteJson).toContain("[FILE]");
    expect(remoteJson).not.toContain("TOP SECRET");

    const local = new FakeProvider();
    await collect(new SanitizingProvider(local, loopback()).chat([{ role: "tool", content: tagged }]));
    const localJson = JSON.stringify(local.seen);
    expect(localJson).toContain("TOP SECRET");
    expect(localJson).not.toContain("mma:file-content");
  });

  it("fail-closed: ошибка классификатора — вызов не уходит", async () => {
    const boom: ProviderEgressGuard = {
      target: { kind: "provider", trusted: false },
      sanitizeChat() {
        throw new Error("classifier exploded");
      },
      rehydrateArgs: (raw) => raw,
    };
    let called = false;
    const inner = new FakeProvider(() => {
      called = true;
      return [{ type: "done" }];
    });
    const provider = new SanitizingProvider(inner, boom);
    await expect(collect(provider.chat([{ role: "user", content: "hi" }]))).rejects.toThrow(
      "classifier exploded",
    );
    expect(called).toBe(false);
  });

  it("сохраняет порядок и типы чанков стрима", async () => {
    const inner = new FakeProvider(() => [
      { type: "text", content: "a" },
      { type: "reasoning", content: "r" },
      { type: "text", content: "b" },
      { type: "done", usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } },
    ]);
    const provider = new SanitizingProvider(inner, external());
    const chunks = await collect(provider.chat([{ role: "user", content: "hi" }]));
    expect(chunks.map((c) => c.type)).toEqual(["text", "reasoning", "text", "done"]);
    expect(chunks[3].usage?.totalTokens).toBe(3);
  });
});

describe("ProviderManager.build wraps both factories (R17)", () => {
  const stub = (): ProviderEgressGuard => ({
    target: { kind: "provider", trusted: false },
    sanitizeChat: (messages, tools) => ({ messages, tools, changed: false }),
    rehydrateArgs: (raw) => raw,
  });

  const providerCfg = {
    type: "openai-compat",
    baseUrl: "https://api.example.com/v1",
    active: "a",
    fallback: false,
    entries: [{ type: "openai-compat", label: "a", baseUrl: "https://api.example.com/v1" }],
  };

  it("активная фабрика обёрнута", () => {
    setEgressGuard(() => stub());
    const { provider } = buildActiveProvider({
      model: "m",
      contextWindow: 4096,
      provider: providerCfg,
    } as never);
    expect(provider).toBeInstanceOf(SanitizingProvider);
  });

  it("managed-фабрика (критик/эксперт) обёрнута", () => {
    setEgressGuard(() => stub());
    const provider = buildManagedProvider(providerCfg as never, "m");
    expect(provider).toBeInstanceOf(SanitizingProvider);
  });

  it("без регистрации guard провайдер не оборачивается", () => {
    const { provider } = buildActiveProvider({
      model: "m",
      contextWindow: 4096,
      provider: providerCfg,
    } as never);
    expect(provider).not.toBeInstanceOf(SanitizingProvider);
  });
});
