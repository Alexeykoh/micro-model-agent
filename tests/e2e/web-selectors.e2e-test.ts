/**
 * Playwright e2e: composer selector row (provider / model / context / reasoning).
 *
 * Covers the selector-switch UX from
 * `docs/specs/2026-09-28-web-selector-loaders-reasoning-design.md`:
 * a switch repaints its button from the server state, the row never sticks in
 * `data-pending`, and the reasoning row lists only the levels the active
 * provider+model supports (dummy `openai-compat` backend → `prompt-tag` →
 * coarse set, no `medium`/`max`). All switches are reverted.
 *
 * Run ONLY on explicit request: `bun run test:e2e`.
 */
import { describe, expect } from "vitest";
import {
  e2e,
  withE2E,
  waitForLiveTab,
  apiGet,
  apiPost,
  artifactsDirFor,
  writeArtifacts,
  type Launched,
} from "./web-helpers";

async function configReasoningMode(baseUrl: string): Promise<string> {
  const { json } = await apiGet(baseUrl, "/api/config");
  const cfg = (json as { config?: { reasoning?: { mode?: string } } }).config;
  return cfg?.reasoning?.mode ?? "";
}

async function configContextWindow(baseUrl: string): Promise<number> {
  const { json } = await apiGet(baseUrl, "/api/config");
  const cfg = (json as { config?: { contextWindow?: number } }).config;
  return cfg?.contextWindow ?? 0;
}

describe("web e2e: composer selectors", () => {
  e2e(
    "context and reasoning switches repaint from server state",
    async () => {
      const dir = artifactsDirFor("selectors-switch");
      await withE2E(dir, async (srv, { page, errors }: Launched) => {
        await waitForLiveTab(page);

        // Reasoning row is visible for the dummy openai-compat backend.
        await expect.poll(() => page.locator('[data-sel="reasoning"]:visible').count()).toBeGreaterThan(0);

        // Coarse level set only: auto/default/none/low/high, no medium/max.
        await page.click("#selReasoningBtn");
        await page.waitForSelector("#selReasoningMenu .mi");
        const items = await page.locator("#selReasoningMenu .mi").allInnerTexts();
        expect(items.map((s) => s.trim())).toEqual(["auto", "default", "none", "low", "high"]);

        // Switch to high through the real menu; the button follows the server.
        await page.locator("#selReasoningMenu .mi", { hasText: /^high$/ }).click();
        await expect.poll(() => page.locator("#selReasoningBtn").innerText(), { timeout: 20_000 }).toMatch(/high/);
        expect(await configReasoningMode(srv.baseUrl)).toBe("high");

        // Context switch through the real menu (deterministic sizes).
        await page.click("#selContextBtn");
        await page.locator("#selContextMenu .mi", { hasText: /^64K$/ }).click();
        await expect.poll(() => page.locator("#selContextBtn").innerText(), { timeout: 20_000 }).toMatch(/64K/);
        expect(await configContextWindow(srv.baseUrl)).toBe(65536);

        // The row never sticks in pending after the switches settle.
        expect(await page.locator(".selectors[data-pending]").count()).toBe(0);

        // Revert both switches.
        await apiPost(srv.baseUrl, "/api/config", { key: "reasoning.mode", value: "auto" });
        await apiPost(srv.baseUrl, "/api/config", { key: "contextWindow", value: 32768 });
        await expect.poll(() => configReasoningMode(srv.baseUrl), { timeout: 20_000 }).toBe("auto");

        await page.screenshot({ path: `${dir}/selectors.png` });
        writeArtifacts(dir, "selectors", { html: await page.content(), consoleErrors: errors });
        expect(errors).toEqual([]);
      });
    },
    180_000,
  );
});
