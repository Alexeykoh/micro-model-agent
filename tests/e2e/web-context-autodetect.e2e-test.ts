/**
 * Playwright e2e over a REAL `mma web` child process with an isolated
 * `MMA_CONFIG_DIR` (see `./web-harness.ts`).
 *
 * Scenarios:
 *  1. `lmstudio preset` — the provider add dialog offers the LM Studio
 *     preset; picking it fills type `lmstudio` + the fixed URL; saving
 *     persists an entry with the new provider type.
 *  2. `context auto-detect` — a stub LM Studio server reports a loaded
 *     65536-token window; after switching the model to the stub model,
 *     `/api/state` carries `contextWindow: 65536` and the topbar selector
 *     flips from 32K to 64K without a reload.
 *
 * Artifacts per scenario land in `_testing/web-e2e/<name>/` (gitignored).
 *
 * Run ONLY on explicit request: `bun run test:e2e`.
 */
import { describe, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { Page } from "playwright";
import {
  e2e,
  withE2E,
  artifactsDirFor,
  writeArtifacts,
  apiPost,
  apiGet,
  type Launched,
} from "./web-helpers";

const STUB_MODEL = "e2e-probe-model";
const STUB_CONTEXT = 65536;

async function openModelPanel(page: Page): Promise<void> {
  await page.click("#openSettings");
  await page.waitForSelector("#overlay.open", { timeout: 10_000 });
  await page.click('[data-p="model"]');
  await page.waitForSelector('[data-panel="model"]', { timeout: 10_000 });
}

/** Minimal LM Studio impersonation: native + OpenAI-compat model lists. */
async function startStub(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/api/v1/models") {
      res.end(
        JSON.stringify({
          models: [
            {
              key: STUB_MODEL,
              max_context_length: 131072,
              loaded_instances: [{ config: { context_length: STUB_CONTEXT } }],
            },
          ],
        }),
      );
    } else if (url.pathname === "/v1/models") {
      res.end(JSON.stringify({ data: [{ id: STUB_MODEL }] }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

function stopStub(server: Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

async function stateContext(baseUrl: string): Promise<unknown> {
  const body = (await apiGet(baseUrl, "/api/state")).json as {
    state?: { contextWindow?: unknown };
  };
  return body.state?.contextWindow;
}

describe("web e2e: provider context auto-detect", () => {
  e2e(
    "lmstudio preset fills type and URL, saves with the new type",
    async () => {
      const dir = artifactsDirFor("ctx-preset");
      await withE2E(dir, async (srv, { page, errors }: Launched) => {
        await openModelPanel(page);
        await page.click(".sec-add");
        await page.waitForSelector("#providerOverlay.open", { timeout: 10_000 });
        await page.locator(".pform-preset").selectOption("lmstudio");
        const inputs = page.locator("#providerFormHost input");
        await expect.poll(() => inputs.nth(0).inputValue(), { timeout: 10_000 }).toBe("lmstudio");
        expect(await inputs.nth(2).inputValue()).toBe("http://localhost:1234/v1");
        await inputs.nth(1).fill("e2e-lmstudio");
        await page.locator(".pform-actions button").first().click();
        await page.waitForSelector("#providerOverlay.open", { state: "hidden", timeout: 10_000 });
        await expect
          .poll(() => page.locator(".provider-item").count(), { timeout: 10_000 })
          .toBeGreaterThan(0);
        const names = await page.locator(".provider-item").allInnerTexts();
        expect(names.some((t) => t.includes("e2e-lmstudio"))).toBe(true);
        const saved = (
          await (await fetch(`${srv.baseUrl}/api/providers`)).json()
        ) as { entries?: Array<{ label?: string; type?: string }> };
        expect(
          (saved.entries ?? []).some((e) => e.label === "e2e-lmstudio" && e.type === "lmstudio"),
        ).toBe(true);
        await page.screenshot({ path: join(dir, "preset-saved.png") });
        writeArtifacts(dir, "preset", { html: await page.content(), consoleErrors: errors });
        expect(errors).toEqual([]);
      });
    },
    120_000,
  );

  e2e(
    "switching to the stub model auto-detects 64K into the topbar",
    async () => {
      const dir = artifactsDirFor("ctx-autodetect");
      const { server, port } = await startStub();
      try {
        // Dead-port dummy backend: the boot probe must find nothing here, or
        // a real server on the box (e.g. lived-in LM Studio) pollutes the
        // scenario with its own window.
        await withE2E(
          dir,
          async (srv, { page, errors }: Launched) => {
            const stubBase = `http://127.0.0.1:${port}/v1`;
            const added = await apiPost(srv.baseUrl, "/api/providers", {
              type: "lmstudio",
              label: "e2e-lm",
              baseUrl: stubBase,
            });
            expect(added.status).toBe(200);
            const switched = await apiPost(srv.baseUrl, "/api/config", {
              key: "provider.active",
              value: "e2e-lm",
            });
            expect(switched.status).toBe(200);
            const modelled = await apiPost(srv.baseUrl, "/api/config", {
              key: "model",
              value: STUB_MODEL,
            });
            expect(modelled.status).toBe(200);
            // The model switch reconfigures → probes the stub → adopts 65536.
            await expect.poll(() => stateContext(srv.baseUrl), { timeout: 30_000 }).toBe(STUB_CONTEXT);
            // The topbar follows the snapshot without a reload.
            await expect
              .poll(() => page.locator("#selContextBtn").innerText(), { timeout: 20_000 })
              .toMatch(/64K/);
            await page.screenshot({ path: join(dir, "topbar-64k.png") });
            writeArtifacts(dir, "autodetect", {
              html: await page.content(),
              consoleErrors: errors,
              extra: { contextWindow: await stateContext(srv.baseUrl) },
            });
            expect(errors).toEqual([]);
          },
          { providerBaseUrl: "http://127.0.0.1:9/v1" },
        );
      } finally {
        await stopStub(server);
      }
    },
    180_000,
  );
});
