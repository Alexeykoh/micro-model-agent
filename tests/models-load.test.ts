// Single-flight guard for the model list: the settings panel re-render calls
// back into `loadModels()` (experts table → `loadModelsFor('')`). Without the
// guard that recursed synchronously (stack overflow) and flooded `/api/models`
// with hundreds of requests during a provider/model switch.
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const realFetch = globalThis.fetch;

type StoreMod = typeof import("../src/modules/webui/assets/js/store");
type LoadMod = typeof import("../src/modules/webui/assets/js/settings/models-load");

let store: StoreMod;
let loader: LoadMod;

function stubApi(payload: unknown): () => number {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => calls;
}

beforeEach(async () => {
  // `api.ts` reads `location.search` at module scope; the frontend test DOM has
  // no `location`, so provide the minimal stub before the first import.
  (globalThis as unknown as { location: unknown }).location = { search: "" };
  store = await import("../src/modules/webui/assets/js/store");
  loader = await import("../src/modules/webui/assets/js/settings/models-load");
  store.settings.models = [];
  store.settings.modelsReady = false;
  store.settings.modelsStatus = "idle";
  store.session.capabilities = null;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  loader.setModelsLoadHooks({});
});

describe("loadModels single-flight", () => {
  it("coalesces re-entrant calls during a settings re-render", async () => {
    const calls = stubApi({
      models: ["qwen4-max"],
      capabilities: { vision: true, video: true, tools: true },
    });
    let renders = 0;
    loader.setModelsLoadHooks({
      renderSelectors: () => {
        // The experts table calls back into the loader on every render; a
        // second fetch here used to recurse until the stack blew up.
        void loader.loadModels();
      },
      renderSettings: () => {
        renders++;
        void loader.loadModels();
      },
    });

    await Promise.all([loader.loadModels(), loader.loadModels()]);

    expect(calls()).toBe(1);
    expect(store.settings.models).toEqual(["qwen4-max"]);
    expect(store.settings.modelsReady).toBe(true);
    expect(store.session.capabilities).toEqual({ vision: true, video: true, tools: true });
    expect(renders).toBeGreaterThan(0);
  });

  it("asks the server to re-fetch from the provider on an explicit refresh", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ models: ["x"], refreshStarted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const started = await loader.requestModelsRefresh();

    expect(started).toBe(true);
    expect(urls).toEqual(["/api/models?refresh=1"]);
  });
});
