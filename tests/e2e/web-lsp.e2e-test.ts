/**
 * Playwright e2e: LSP sidebar info panel (global toggles + manual-install
 * hints) and the `lsp.enabled` / `lsp.offline` registry keys hot-applying
 * through `POST /api/config`.
 *
 * The isolated server boots with the built-in LSP defaults. To keep the run
 * hermetic and fast we pin `lsp.offline` / `lsp.enabled` via the API BEFORE the
 * sidebar tab opens: offline skips npx entirely, and a disabled module never
 * probes, so no language-server process is spawned by the scenario.
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
import { startE2EServer, stopE2EServer } from "./web-harness";

/** `config.lsp` section of the isolated server. */
async function lspConfig(baseUrl: string): Promise<Record<string, unknown>> {
  const { json } = await apiGet(baseUrl, "/api/config");
  const cfg = (json as { config?: Record<string, unknown> }).config ?? {};
  return (cfg.lsp as Record<string, unknown>) ?? {};
}

/** Flags carried by `GET /api/lsp/doctor` (`LspModule.getFlags`). */
async function doctorFlags(baseUrl: string): Promise<Record<string, unknown>> {
  const { json } = await apiGet(baseUrl, "/api/lsp/doctor");
  return (json as { flags?: Record<string, unknown> }).flags ?? {};
}

describe("web e2e: LSP setup", () => {
  e2e(
    "info panel renders toggles and manual-install commands",
    async () => {
      const dir = artifactsDirFor("web-lsp");
      await withE2E(dir, async (srv, { page, errors }: Launched) => {
        await waitForLiveTab(page);
        // Offline skips npx, so the on-open diagnosis resolves fast and
        // produces a manual-install command per applicable npx server.
        await apiPost(srv.baseUrl, "/api/config", { key: "lsp.offline", value: true });

        await page.click('.sb-tab[data-tab="lsp"]');
        await page.waitForSelector("#pane-lsp .lsp-info-btn", { timeout: 10_000 });
        await page.click("#pane-lsp .lsp-info-btn");
        await page.waitForSelector("#subOverlay.open", { timeout: 10_000 });

        await expect
          .poll(() => page.locator("#subHost .lsp-toggle .toggle").count(), { timeout: 15_000 })
          .toBe(2);
        await expect
          .poll(() => page.locator("#subHost .lsp-cmd").count(), { timeout: 25_000 })
          .toBeGreaterThan(0);

        await page.screenshot({ path: `${dir}/lsp-info.png` });

        // Revert the scenario's own write.
        await apiPost(srv.baseUrl, "/api/config", { key: "lsp.offline", value: false });

        writeArtifacts(dir, "web-lsp", { html: await page.content(), consoleErrors: errors });
        expect(errors).toEqual([]);
      });
    },
    180_000,
  );

  e2e(
    "global LSP toggles hot-apply and persist through /api/config",
    async () => {
      const dir = artifactsDirFor("web-lsp-api");
      const srv = await startE2EServer({ artifactsDir: dir });
      try {
        expect(await doctorFlags(srv.baseUrl)).toMatchObject({ enabled: true, offline: false });

        const off = await apiPost(srv.baseUrl, "/api/config", { key: "lsp.offline", value: true });
        expect(off.status).toBe(200);
        expect(await lspConfig(srv.baseUrl)).toMatchObject({ offline: true });
        expect(await doctorFlags(srv.baseUrl)).toMatchObject({ offline: true });

        await apiPost(srv.baseUrl, "/api/config", { key: "lsp.enabled", value: false });
        expect(await doctorFlags(srv.baseUrl)).toMatchObject({ enabled: false });

        // Revert the scenario's own writes.
        await apiPost(srv.baseUrl, "/api/config", { key: "lsp.enabled", value: true });
        await apiPost(srv.baseUrl, "/api/config", { key: "lsp.offline", value: false });
        expect(await doctorFlags(srv.baseUrl)).toMatchObject({ enabled: true, offline: false });
      } finally {
        await stopE2EServer(srv);
      }
    },
    180_000,
  );
});
