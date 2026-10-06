/**
 * Playwright e2e: sidebar context-breakdown bar.
 *
 * Guards the segmented bar being rendered as separate rounded pills with a gap,
 * and the hover/focus tooltips per category. The isolated server has no LLM
 * turn at boot, so a synthetic `contextBreakdown` is injected into `GET
 * /api/state` (the sidebar refreshes it every 2s) — no real provider needed.
 *
 * Run ONLY on explicit request: `bun run test:e2e`.
 */
import { describe, expect } from "vitest";
import { artifactsDirFor } from "./web-harness";
import { e2e, withE2E, waitForLiveTab, writeArtifacts, type Launched } from "./web-helpers";

// Mirrors the screenshot the feature was specced against.
const BREAKDOWN = {
  window: 32768,
  used: 20300,
  system: 2600,
  tools: 4600,
  history: 13100,
  reserve: 4900,
  free: 7568,
};

describe("web e2e: context breakdown bar", () => {
  e2e(
    "renders pill segments with gaps and hover tooltips",
    async () => {
      const dir = artifactsDirFor("context-bar");
      await withE2E(dir, async (_srv, { page, errors }: Launched) => {
        await waitForLiveTab(page);

        // Inject breakdown into the state poll (sidebar refreshes every 2s).
        await page.route("**/api/state*", async (route) => {
          const res = await route.fetch();
          const json = (await res.json()) as { state?: Record<string, unknown> };
          json.state = {
            ...(json.state || {}),
            contextUsed: BREAKDOWN.used,
            contextLimit: BREAKDOWN.window,
            contextBreakdown: BREAKDOWN,
          };
          await route.fulfill({ response: res, json });
        });

        // Five categories land in both the bar and the legend.
        await expect
          .poll(() => page.locator("#usage .seglegend .segl-item").count(), { timeout: 15_000 })
          .toBe(5);
        await expect.poll(() => page.locator("#usage .bar.segbar i").count()).toBe(5);

        // Pill layout: taller bar with a gap between categories.
        const barStyle = await page.locator("#usage .bar.segbar").evaluate((node) => {
          const cs = getComputedStyle(node as HTMLElement);
          return { height: cs.height, gap: cs.gap };
        });
        expect(barStyle.height).toBe("10px");
        expect(barStyle.gap).toBe("3px");

        // Segment tooltip: name · tokens · share.
        await page.hover("#usage .bar.segbar i.seg-history");
        await expect
          .poll(() => page.locator(".ctip.show").innerText(), { timeout: 5_000 })
          .toMatch(/13\.1K/);
        await page.screenshot({ path: `${dir}/context-bar.png` });

        // Legend tooltip behaves the same.
        await page.hover("#usage .seglegend .segl-item:has(.segl-dot.seg-tools)");
        await expect
          .poll(() => page.locator(".ctip.show").innerText(), { timeout: 5_000 })
          .toMatch(/4\.6K\s*·?\s*14%/);

        writeArtifacts(dir, "context-bar", {
          html: await page.content(),
          consoleErrors: errors,
        });
        expect(errors).toEqual([]);
      });
    },
    180_000,
  );
});
