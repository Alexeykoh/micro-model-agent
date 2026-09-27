/**
 * Playwright e2e: full-config-surfaces web additions (branch
 * `feat/full-config-surfaces`).
 *
 * - new Settings panels render (network/browser/persistence/retry/lists/advanced-json)
 * - security panel keeps the bash/network toggles
 * - generic controls write + revert (bool/int/list/json) and reject bad JSON
 * - provider form exposes cache fields; create + delete round-trip
 * - MCP add + delete round-trip; LSP edit + revert
 * - web slash `/security` (+ `/config` write path it shares)
 *
 * Isolated `MMA_CONFIG_DIR` per scenario; mutating checks revert.
 * Run ONLY on explicit request: `bun run test:e2e` (under node, not bun).
 */
import { describe, expect } from "vitest";
import {
  e2e,
  withE2E,
  sendLine,
  waitCmdOut,
  waitForLiveTab,
  apiGet,
  apiPost,
  artifactsDirFor,
  writeArtifacts,
  type Launched,
} from "./web-helpers";

const ADV_GROUPS = ["model", "context", "reasoning", "agent", "network", "browser", "sessions", "service", "retry", "lists", "security", "json"];

async function openSettings(page: Launched["page"]): Promise<void> {
  await page.click("#openSettings");
  await page.waitForSelector("#overlay.open", { timeout: 10_000 });
}

// Deep settings live in collapsed <details> inside Advanced — expand first.
async function openAdvGroup(page: Launched["page"], group: string): Promise<void> {
  await page.click('#setMenu [data-p="advanced"]');
  const det = page.locator(`[data-panel="advanced"] details[data-group="${group}"]`);
  if ((await det.getAttribute("open")) === null) {
    await det.locator("summary").click();
  }
  await det.locator(".row").first().waitFor({ state: "visible", timeout: 10_000 });
}

async function configValue(baseUrl: string, dotted: string): Promise<unknown> {
  const { json } = await apiGet(baseUrl, "/api/config");
  const cfg = (json as { config?: Record<string, unknown> }).config ?? {};
  return dotted.split(".").reduce<unknown>((o, k) => ((o as Record<string, unknown>) ?? {})[k], cfg);
}

async function apiPut(baseUrl: string, path: string, body: unknown): Promise<{ status: number; json: never }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as never };
}

async function apiDelete(baseUrl: string, path: string): Promise<{ status: number; json: never }> {
  const res = await fetch(`${baseUrl}${path}`, { method: "DELETE" });
  return { status: res.status, json: (await res.json()) as never };
}

function panelRow(page: Launched["page"], panel: string, label: string | RegExp) {
  return page.locator(`[data-panel="${panel}"] .row`, { hasText: label });
}

describe("web e2e: config surfaces", () => {
  e2e(
    "advanced nests deep settings; security keeps bash/network toggles",
    async () => {
      const dir = artifactsDirFor("cfg-panels");
      await withE2E(dir, async (_srv, { page, errors }: Launched) => {
        await openSettings(page);
        await page.click('#setMenu [data-p="advanced"]');
        for (const group of ADV_GROUPS) {
          const det = page.locator(`[data-panel="advanced"] details[data-group="${group}"]`);
          await expect.poll(() => det.count(), { timeout: 10_000 }).toBe(1);
          await expect
            .poll(() => det.locator("summary").innerText(), { timeout: 10_000 })
            .not.toHaveLength(0);
        }
        // The bash/network master toggles must stay visible (registry + UI).
        await page.click('#setMenu [data-p="security"]');
        const sec = page.locator('[data-panel="security"]');
        await expect.poll(() => sec.innerText(), { timeout: 10_000 }).toMatch(/bash/i);
        await expect.poll(() => sec.innerText(), { timeout: 10_000 }).toMatch(/network/i);
        // Visual reference: advanced with one group expanded.
        await openAdvGroup(page, "retry");
        await page.screenshot({ path: `${dir}/advanced-groups.png` });
        // No raw i18n keys may leak into the menu (all panels localized).
        await expect
          .poll(() => page.locator("#setMenu").innerText(), { timeout: 10_000 })
          .not.toMatch(/web\.settings\./);
        await page.keyboard.press("Escape");
        writeArtifacts(dir, "cfg-panels", {
          html: await page.content(),
          consoleErrors: errors,
        });
        expect(errors).toEqual([]);
      });
    },
    180_000,
  );

  e2e(
    "generic controls write + revert; bad JSON is rejected inline",
    async () => {
      const dir = artifactsDirFor("cfg-controls");
      await withE2E(dir, async (srv, { page, errors }: Launched) => {
        const { baseUrl } = srv;
        await openSettings(page);

        // bool toggle + revert (general → auto-plan).
        await page.click('#setMenu [data-p="general"]');
        const boolToggle = panelRow(page, "general", "auto-plan").locator(".toggle");
        const wasOn = await boolToggle.evaluate((el) => el.classList.contains("on"));
        await boolToggle.click();
        await expect.poll(() => configValue(baseUrl, "autoPlan"), { timeout: 10_000 }).toBe(!wasOn);
        await boolToggle.click();
        await expect.poll(() => configValue(baseUrl, "autoPlan"), { timeout: 10_000 }).toBe(wasOn);

        // int input + revert (advanced → retry group → max retries).
        await openAdvGroup(page, "retry");
        const origRetries = Number(await configValue(baseUrl, "retry.maxRetries"));
        const intInput = page.locator('[data-panel="advanced"] input[aria-label="max retries"]');
        await intInput.fill(String(origRetries + 1));
        await intInput.press("Tab");
        await expect
          .poll(() => configValue(baseUrl, "retry.maxRetries"), { timeout: 10_000 })
          .toBe(origRetries + 1);
        await intInput.fill(String(origRetries));
        await intInput.press("Tab");
        await expect
          .poll(() => configValue(baseUrl, "retry.maxRetries"), { timeout: 10_000 })
          .toBe(origRetries);

        // list input + revert (advanced → lists group → default tool tags).
        await openAdvGroup(page, "lists");
        const listInput = panelRow(page, "advanced", "default tool tags").locator("input");
        await listInput.fill("file, code, e2eprobe");
        await listInput.press("Tab");
        await expect
          .poll(() => configValue(baseUrl, "tools.defaultTags"), { timeout: 10_000 })
          .toEqual(["file", "code", "e2eprobe"]);
        await listInput.fill("file, code");
        await listInput.press("Tab");
        await expect
          .poll(() => configValue(baseUrl, "tools.defaultTags"), { timeout: 10_000 })
          .toEqual(["file", "code"]);

        // json textarea: valid writes, invalid shows inline error and keeps old value.
        await openAdvGroup(page, "json");
        const jsonRow = panelRow(page, "advanced", "pricing overrides");
        const area = jsonRow.locator("textarea");
        await area.fill('{"e2e-probe":{"input":1,"output":2}}');
        await area.press("Tab");
        await expect
          .poll(() => configValue(baseUrl, "pricing.overrides"), { timeout: 10_000 })
          .toEqual({ "e2e-probe": { input: 1, output: 2 } });
        await area.fill("{oops");
        await area.press("Tab");
        await expect
          .poll(() => jsonRow.locator(".json-err").isVisible(), { timeout: 10_000 })
          .toBe(true);
        expect(await configValue(baseUrl, "pricing.overrides")).toEqual({
          "e2e-probe": { input: 1, output: 2 },
        });
        await area.fill("{}");
        await area.press("Tab");
        await expect
          .poll(() => configValue(baseUrl, "pricing.overrides"), { timeout: 10_000 })
          .toEqual({});
        await page.keyboard.press("Escape");

        writeArtifacts(dir, "cfg-controls", {
          html: await page.content(),
          consoleErrors: errors,
        });
        expect(errors).toEqual([]);
      });
    },
    240_000,
  );

  e2e(
    "provider form exposes cache fields; create + delete round-trip",
    async () => {
      const dir = artifactsDirFor("cfg-provider");
      await withE2E(dir, async (srv, { page, errors }: Launched) => {
        const { baseUrl } = srv;
        await openSettings(page);
        await page.click('#setMenu [data-p="model"]');
        await page.locator('[data-panel="model"] .sec-add').click();
        const form = page.locator("#providerFormHost .pform");
        await form.waitFor({ timeout: 10_000 });

        // New fields from this branch exist.
        expect(await form.locator('input[placeholder="8192"]').count()).toBe(1);
        expect(await form.locator('select[aria-label="cache mechanism"]').count()).toBe(1);
        expect(await form.locator('select[aria-label="cache report format"]').count()).toBe(1);

        // Advanced fields live inside a collapsed <details> — expand it.
        await form.locator("details.pform-adv > summary").click();
        await form.locator('input[placeholder="8192"]').waitFor({ state: "visible", timeout: 10_000 });

        await form.locator('input[placeholder="openai-compat"]').fill("openai-compat");
        await form.locator('input[placeholder="my-provider"]').fill("e2e-cap-probe");
        await form.locator('input[placeholder="http://localhost:1234/v1"]').fill("http://127.0.0.1:9/v1");
        await form.locator('input[placeholder="8192"]').fill("16384");
        await form.locator('select[aria-label="cache mechanism"]').selectOption("local");
        await form.locator(".pform-actions button").first().click();

        const entriesOf = async () => {
          const body = (await apiGet(baseUrl, "/api/providers")).json as {
            entries?: Array<{ label?: string; type?: string; maxCompletionTokens?: number; cache?: { mechanism?: string } }>;
          };
          return body.entries ?? [];
        };
        await expect
          .poll(
            async () =>
              (await entriesOf()).find((e) => (e.label ?? e.type) === "e2e-cap-probe"),
            { timeout: 15_000 },
          )
          .toMatchObject({ maxCompletionTokens: 16384, cache: { mechanism: "local" } });

        // Delete it again through the UI danger chip.
        const item = page.locator(".provider-item", { hasText: "e2e-cap-probe" });
        await item.locator("button", { hasText: "delete" }).click();
        await expect
          .poll(async () => (await entriesOf()).some((e) => (e.label ?? e.type) === "e2e-cap-probe"), {
            timeout: 15_000,
          })
          .toBe(false);
        await page.keyboard.press("Escape");

        writeArtifacts(dir, "cfg-provider", {
          html: await page.content(),
          consoleErrors: errors,
        });
        expect(errors).toEqual([]);
      });
    },
    240_000,
  );

  e2e(
    "MCP add + delete; LSP edit + revert; /security slash",
    async () => {
      const dir = artifactsDirFor("cfg-mcp-lsp-cmd");
      await withE2E(dir, async (srv, { page, errors }: Launched) => {
        const { baseUrl } = srv;
        await openSettings(page);
        await page.click('#setMenu [data-p="plugins"]');

        // MCP create through the inline form (stdio needs a command only).
        await page.locator('[data-panel="plugins"] button', { hasText: "add MCP server" }).click();
        const mcpForm = page.locator('[data-panel="plugins"] .pform');
        await mcpForm.waitFor({ timeout: 10_000 });
        await mcpForm.locator('input[placeholder="my-server"]').fill("e2e-mcp-probe");
        await mcpForm.locator('input[placeholder="npx"]').fill("node");
        await mcpForm.locator(".pform-actions button").first().click();
        const mcpNames = async () => {
          const body = (await apiGet(baseUrl, "/api/plugins")).json as {
            mcp?: Array<{ id?: string; name?: string }>;
          };
          return (body.mcp ?? []).map((m) => m.id ?? m.name ?? "");
        };
        await expect.poll(mcpNames, { timeout: 15_000 }).toContain("e2e-mcp-probe");
        // Delete it again through the row control.
        const mcpRow = page.locator('[data-panel="plugins"] .list-line', { hasText: "e2e-mcp-probe" });
        await mcpRow.locator("button", { hasText: "delete" }).click();
        await expect.poll(mcpNames, { timeout: 15_000 }).not.toContain("e2e-mcp-probe");

        // LSP: edit the first server timeout, verify, revert.
        const lspTimeout = async (lang: string) => {
          const body = (await apiGet(baseUrl, "/api/lsp")).json as {
            servers?: Array<{ lang?: string; timeout?: number }>;
          };
          return (body.servers ?? []).find((s) => s.lang === lang)?.timeout;
        };
        const lspRow = page.locator('[data-panel="plugins"] .list-line', { hasText: "typescript" }).first();
        await lspRow.waitFor({ timeout: 10_000 });
        const origTimeout = await lspTimeout("typescript");
        await lspRow.locator("button", { hasText: "edit" }).click();
        const lspForm = page.locator('[data-panel="plugins"] .pform');
        await lspForm.waitFor({ timeout: 10_000 });
        const probeTimeout = (origTimeout ?? 30000) === 31000 ? 32000 : 31000;
        await lspForm.locator('input[placeholder="30000"]').fill(String(probeTimeout));
        await lspForm.locator(".pform-actions button").first().click();
        await expect.poll(() => lspTimeout("typescript"), { timeout: 15_000 }).toBe(probeTimeout);
        // Revert via API (same contract the form uses).
        const put = await apiPut(baseUrl, "/api/lsp/typescript", { timeout: origTimeout });
        expect(put.status).toBe(200);
        await expect.poll(() => lspTimeout("typescript"), { timeout: 15_000 }).toBe(origTimeout ?? null);
        await apiDelete(baseUrl, "/api/mcp/e2e-mcp-probe").catch(() => {});
        await page.keyboard.press("Escape");

        // Slash commands share the registry write path — verify both directions.
        await waitForLiveTab(page);
        await sendLine(page, "/security status");
        await waitCmdOut(page, /security/i);
        await sendLine(page, "/security boguskey");
        await waitCmdOut(page, /unknown/i);
        await sendLine(page, "/config autoPlan off");
        await waitCmdOut(page, /autoPlan = off/);
        await expect.poll(() => configValue(baseUrl, "autoPlan"), { timeout: 10_000 }).toBe(false);
        await sendLine(page, "/config autoPlan on");
        await waitCmdOut(page, /autoPlan = on/);
        await expect.poll(() => configValue(baseUrl, "autoPlan"), { timeout: 10_000 }).toBe(true);

        writeArtifacts(dir, "cfg-mcp-lsp-cmd", {
          html: await page.content(),
          consoleErrors: errors,
        });
        expect(errors).toEqual([]);
      });
    },
    300_000,
  );
});
