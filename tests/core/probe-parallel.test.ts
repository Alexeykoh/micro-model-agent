// INV-W6/§4 B2: пробы внутри `probeProviderContext` идут параллельно —
// суммарное время ≈ max по источникам, а не их сумма. Локальный HTTP-стаб с
// произвольной задержкой; внешние хосты не дёргаются.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { probeProviderContext } from "../../src/llm/provider-context";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

function respond(res: ServerResponse, status: number, body: unknown, delayMs: number): void {
  setTimeout(() => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }, delayMs);
}

async function listen(handler: Handler): Promise<{ srv: Server; base: string }> {
  const srv = createServer(handler);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const { port } = srv.address() as AddressInfo;
  return { srv, base: `http://127.0.0.1:${port}/v1` };
}

/** Первый приход запроса на путь (ms от старта), либо undefined. */
function firstHitAt(hits: Map<string, number>, path: string, started: number): number | undefined {
  const at = hits.get(path);
  return at === undefined ? undefined : at - started;
}

describe("probeProviderContext runs its probes in parallel", () => {
  // Другие тесты общего процесса подменяют `global.fetch` — подставляем
  // рантаймный fetch, чтобы стабы говорили с настоящим локальным сервером.
  let sharedFetch: typeof global.fetch;

  beforeEach(() => {
    sharedFetch = global.fetch;
    global.fetch = Bun.fetch.bind(Bun) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = sharedFetch;
  });

  it("starts every source at once: spread of first hits ≈ 0, total ≈ max", async () => {
    const DELAY_MS = 250;
    const hits = new Map<string, number>();
    const { srv, base } = await listen((req, res) => {
      const url = req.url ?? "/";
      if (!hits.has(url)) hits.set(url, performance.now());
      respond(res, 404, {}, DELAY_MS);
    });
    try {
      const started = performance.now();
      const probe = await probeProviderContext(base, "any-model");
      const elapsed = performance.now() - started;
      expect(probe).toBeNull();

      // Первый запрос каждого ИСТОЧНИКА. `/api/show` (внутренняя последовательность
      // Ollama) в выборку не входит.
      const firstHits = ["/api/v1/models", "/api/ps", "/props", "/v1/models"]
        .map((p) => firstHitAt(hits, p, started))
        .filter((v): v is number => v !== undefined);
      expect(firstHits).toHaveLength(4);
      const spread = Math.max(...firstHits) - Math.min(...firstHits);
      // Параллельно: все источники стартуют в одном окне. Последовательно
      // первый из них ждал бы ~750 мс (сумма трёх предыдущих проб).
      expect(spread).toBeLessThan(150);
      // Последовательный путь ≈ 1250 мс (lm + ps/show + props + compat),
      // параллельный ≈ 500 мс (внутренняя пара ps/show — самая медленная).
      expect(elapsed).toBeLessThan(900);
    } finally {
      srv.close();
    }
  });

  it("keeps the original source priority when several sources answer", async () => {
    const { srv, base } = await listen((req, res) => {
      const url = req.url ?? "/";
      // LM Studio отвечает медленнее OpenAI-compat, но остаётся первым источником.
      if (url.endsWith("/api/v1/models")) {
        respond(
          res,
          200,
          { models: [{ key: "m", loaded_instances: [{ config: { context_length: 65536 } }] }] },
          300,
        );
        return;
      }
      if (url.endsWith("/v1/models")) {
        respond(res, 200, { data: [{ id: "m", context_length: 8192 }] }, 50);
        return;
      }
      respond(res, 404, {}, 50);
    });
    try {
      const probe = await probeProviderContext(base, "m");
      // Приоритет прежний: LM Studio (65536), а не более быстрый compat (8192).
      expect(probe).toEqual({ model: "m", actual: 65536 });
    } finally {
      srv.close();
    }
  });
});
