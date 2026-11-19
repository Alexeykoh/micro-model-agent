// INV-W7: зависший провайдер не должен держать HTTP-ответ открытым —
// `listProviderModels` ограничен `LIST_MODELS_TIMEOUT_MS` (волна B, спека
// 2026-11-04-webui-latency-design.md §4/§6). До правки fetch висел до
// TCP-таймаута ОС (замер: >15 с и всё ещё висит).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { LIST_MODELS_TIMEOUT_MS, listProviderModels } from "../../src/llm/openai-models";

describe("listProviderModels timeout", () => {
  // В общем процессе `bun test` другие тесты подменяют `global.fetch` и не
  // всегда возвращают его: подставляем рантаймный fetch, чтобы проверка шла
  // по настоящей сети, а не по чужому стабу (тот же приём, что в
  // `tests/helpers/webui-server.ts`).
  let sharedFetch: typeof global.fetch;

  beforeEach(() => {
    sharedFetch = global.fetch;
    global.fetch = Bun.fetch.bind(Bun) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = sharedFetch;
  });

  it("gives up on a hanging provider around LIST_MODELS_TIMEOUT_MS", async () => {
    // Сервер принимает соединение и никогда не отвечает (провайдер «висит»).
    const sockets: Socket[] = [];
    const srv: Server = createServer(() => {
      /* no response on purpose */
    });
    srv.on("connection", (socket) => sockets.push(socket));
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
    const address = srv.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const started = performance.now();
      await expect(
        listProviderModels({ baseUrl: `http://127.0.0.1:${port}/v1`, userAgent: "test" }),
      ).rejects.toThrow();
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(LIST_MODELS_TIMEOUT_MS - 300);
      // Небольшой запас на планировщик: главное — не минуты, как до правки.
      expect(elapsed).toBeLessThan(LIST_MODELS_TIMEOUT_MS + 2000);
    } finally {
      for (const socket of sockets) socket.destroy();
      srv.close();
    }
  });
});
