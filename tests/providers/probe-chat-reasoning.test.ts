// Guard: readiness-проба не считает живую reasoning-модель отсутствующей.
//
// Регресс из стресс-теста (волна 14): `GET /v1/ready` отдавал 503 `no-model`,
// пока задачи выполнялись за 11 с. Проба шлёт `max_tokens: 1` и требовала
// непустой `content`, а reasoning-модель на одном токене отдаёт пустой текст.
// Ответ 200 с `choices[0]` — уже доказательство, что модель приняла запрос.
import { describe, it, expect, afterEach } from "vitest";
import { probeChat, preflightProvider } from "../../src/modules/providers/preflight";

const cfg = { baseUrl: "http://127.0.0.1:1234/v1", apiKey: "k", model: "e4b" };
const realFetch = globalThis.fetch;

function stubFetch(payload: unknown, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("probeChat: reasoning-модель", () => {
  it("200 с пустым content считается ответом модели", async () => {
    stubFetch({ choices: [{ message: { content: "", reasoning_content: "" }, finish_reason: "length" }] });

    const text = await probeChat(cfg, 1000);
    expect(text).not.toBe("");

    const res = await preflightProvider(cfg, { probe: (c, t) => probeChat(c, t) });
    expect(res.ok).toBe(true);
    expect(res.reason).toBe("ok");
  });

  it("reasoning_content без content тоже годится", async () => {
    stubFetch({ choices: [{ message: { reasoning_content: "thinking" } }] });

    expect(await probeChat(cfg, 1000)).toBe("thinking");
  });

  it("200 без choices — по-прежнему no-model", async () => {
    stubFetch({ choices: [] });

    expect(await probeChat(cfg, 1000)).toBe("");
    const res = await preflightProvider(cfg, { probe: (c, t) => probeChat(c, t) });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no-model");
  });

  it("4xx — unreachable, а не no-model", async () => {
    stubFetch({ error: "model not found" }, 404);

    const res = await preflightProvider(cfg, { probe: (c, t) => probeChat(c, t) });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("unreachable");
  });
});
