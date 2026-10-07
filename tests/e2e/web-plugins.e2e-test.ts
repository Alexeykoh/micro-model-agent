/**
 * Playwright e2e: the Plugins sidebar tab — live enable/disable toggle through
 * `POST /api/plugins/:name` and the details popup in the nested overlay.
 *
 * The isolated server has no user plugins on disk, so the list shows builtins
 * only. The scenario toggles one builtin (reverting it afterwards) to prove the
 * live path end to end: no restart, config persisted, `GET /api/plugins`
 * reporting the new state.
 *
 * Run ONLY on explicit request: `bun run test:e2e`.
 */
import { describe, expect } from "vitest";
import {
  e2e,
  withE2E,
  waitForLiveTab,
  apiGet,
  artifactsDirFor,
  writeArtifacts,
  type Launched,
} from "./web-helpers";
import { startE2EServer, stopE2EServer } from "./web-harness";

interface PluginRow {
  name: string;
  enabled: boolean;
  builtin: boolean;
  warnings: string[];
}

async function pluginRows(baseUrl: string): Promise<PluginRow[]> {
  const { json } = await apiGet(baseUrl, "/api/plugins");
  return (json as { plugins?: PluginRow[] }).plugins ?? [];
}

describe("web e2e: plugins tab", () => {
  e2e(
    "lists plugins and toggles one live from the sidebar",
    async () => {
      const dir = artifactsDirFor("web-plugins");
      await withE2E(dir, async (srv, { page, errors }: Launched) => {
        await waitForLiveTab(page);
        const before = await pluginRows(srv.baseUrl);
        expect(before.length).toBeGreaterThan(0);

        await page.click('.sb-tab[data-tab="plugins"]');
        await page.waitForSelector("#pane-plugins .plg-row", { timeout: 10_000 });
        await expect.poll(() => page.locator("#pane-plugins .plg-row").count()).toBeGreaterThan(0);
        await expect(page.locator("#pane-plugins .plg-summary")).toContainText("active");

        // Flip the first toggle and expect the server to agree.
        const firstRow = page.locator("#pane-plugins .plg-row").first();
        const name = (await firstRow.locator(".plg-name").textContent())?.trim() || "";
        const wasOn = (await firstRow.locator(".toggle.on").count()) > 0;
        await firstRow.locator(".toggle").click();
        await expect
          .poll(async () => (await pluginRows(srv.baseUrl)).find((p) => p.name === name)?.enabled, {
            timeout: 10_000,
          })
          .toBe(!wasOn);
        await page.screenshot({ path: `${dir}/plugins-tab.png` });

        // Revert the scenario's own write.
        await firstRow.locator(".toggle").click();
        await expect
          .poll(async () => (await pluginRows(srv.baseUrl)).find((p) => p.name === name)?.enabled, {
            timeout: 10_000,
          })
          .toBe(wasOn);

        writeArtifacts(dir, "web-plugins", { html: await page.content(), consoleErrors: errors });
        expect(errors).toEqual([]);
      });
    },
    180_000,
  );

  e2e(
    "opens the details popup with metadata and the permissions hint",
    async () => {
      const dir = artifactsDirFor("web-plugins-info");
      await withE2E(dir, async (srv, { page, errors }: Launched) => {
        await waitForLiveTab(page);
        await page.click('.sb-tab[data-tab="plugins"]');
        await page.waitForSelector("#pane-plugins .plg-row", { timeout: 10_000 });
        await page.locator("#pane-plugins .plg-row").first().click();
        await page.waitForSelector("#subOverlay.open", { timeout: 10_000 });
        // Declarations are shown as such — the tab must not imply enforcement.
        await expect(page.locator("#subHost")).toContainText("not enforcement");
        await page.screenshot({ path: `${dir}/plugins-info.png` });
        writeArtifacts(dir, "web-plugins-info", { html: await page.content(), consoleErrors: errors });
        expect(errors).toEqual([]);
      });
    },
    180_000,
  );

  e2e(
    "GET /api/plugins reports a real enabled flag and rejects unknown toggles",
    async () => {
      const dir = artifactsDirFor("web-plugins-api");
      const srv = await startE2EServer({ artifactsDir: dir });
      try {
        const rows = await pluginRows(srv.baseUrl);
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) expect(typeof row.enabled).toBe("boolean");

        const ghost = await apiPost(srv.baseUrl, "/api/plugins/does-not-exist", { enabled: false });
        expect(ghost.status).toBe(404);
      } finally {
        await stopE2EServer(srv);
      }
    },
    120_000,
  );
});
