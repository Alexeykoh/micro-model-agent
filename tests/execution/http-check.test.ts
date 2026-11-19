// Guard: `http:`-проверка шага (W1 спеки turn-runtime-gate).
//
// Формат `http:<url>[~маркер]`: 2xx обязателен, маркер ищется в теле (кап
// 256 KiB), редиректы не разыменовываются, таймаут — отказ с причиной.
import { describe, it, expect } from "vitest";
import { parseHttpTarget, runHttpCheck } from "../../src/modules/execution/http-check";

function fetchReturning(status: number, body = "", headers: Record<string, string> = {}) {
  return (async () =>
    new Response(body, { status, headers: { "content-type": "text/html", ...headers } })) as typeof fetch;
}

describe("http-проверка шага", () => {
  it("парсит url и маркер", () => {
    expect(parseHttpTarget("http://127.0.0.1:5173/")).toEqual({ url: "http://127.0.0.1:5173/" });
    expect(parseHttpTarget("http://x/~Каталог")).toEqual({
      url: "http://x/",
      marker: "Каталог",
    });
    expect(parseHttpTarget("ftp://x")).toBeNull();
    expect(parseHttpTarget("   ")).toBeNull();
  });

  it("2xx без маркера — успех", async () => {
    const r = await runHttpCheck("http://x/", { fetchImpl: fetchReturning(200, "ok") });

    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
  });

  it("2xx с маркером в теле — успех, без маркера — отказ", async () => {
    const ok = await runHttpCheck("http://x/~Каталог", {
      fetchImpl: fetchReturning(200, "<h2>Каталог</h2>"),
    });
    expect(ok.ok).toBe(true);

    const bad = await runHttpCheck("http://x/~Каталог", { fetchImpl: fetchReturning(200, "пусто") });
    expect(bad.ok).toBe(false);
    expect(String(bad.reason)).toContain("marker");
  });

  it("404 — отказ с статусом", async () => {
    const r = await runHttpCheck("http://x/", { fetchImpl: fetchReturning(404) });

    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(String(r.reason)).toContain("404");
  });

  it("таймаут — отказ с причиной, не исключение", async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      })) as unknown as typeof fetch;

    const r = await runHttpCheck("http://x/", { fetchImpl: hanging, timeoutMs: 20 });

    expect(r.ok).toBe(false);
    expect(String(r.reason)).toMatch(/timeout/i);
  });

  it("редирект не разыменовывается: 3xx — отказ", async () => {
    const r = await runHttpCheck("http://x/", {
      fetchImpl: fetchReturning(302, "", { location: "/login" }),
    });

    expect(r.ok).toBe(false);
    expect(r.status).toBe(302);
  });
});
