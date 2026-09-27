/**
 * Playwright e2e: settings information architecture (branch
 * `feat/full-config-surfaces`).
 *
 * - every panel renders a non-empty body with named sections (no raw i18n keys)
 * - generic controls write + revert (bool/int/list/json) and reject bad JSON
 * - provider / MCP / LSP edits open in the shared nested dialog
 * - settings search finds a deep key and navigates to its panel
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
  artifactsDirFor,
  writeArtifacts,
  type Launched,
} from "./web-helpers";

const PANELS = [
  "general",
  "model",
  "context",
  "reasoning",
  "agent",
  "network",
  "browser",
  "sessions",
  "ui",
  "memory",
  "skills",
  "plugins",
  "security",
  "advanced",
];

async function openSettings(page: Launched["page"]): Promise<void> {
  await page.click("#openSettings");
  await page.waitForSelector("#overlay.open", { timeout: 10_000 });
}

async function openPanel(page: Launched["page"], panel: string): Promise<void> {
  await page.click(`#setMenu [data-p="${panel}"]`);
  const body = page.locator(`[data-panel="${panel}"]`);
  await expect.poll(() => body.isVisible(), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => body.innerText(), { timeout: 10_000 }).not.toHaveLength(0);
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
    "every panel renders named sections and no raw keys leak",
    async () => {
      const dir = artifactsDirFor("cfg-panels");
      await withE2E(dir, async (_srv, { page, errors }: Launched) => {
        await openSettings(page);
        for (const panel of PANELS) {
          await openPanel(page, panel);
          const body = page.locator(`[data-panel="${panel}"]`);
          await expect.poll(() => body.innerText(), { timeout: 10_000 }).not.toHaveLength(0);
          await expect.poll(() => body.innerText(), { timeout: 10_000 }).not.toMatch(/web\.settings\./);
        }
        // No raw i18n keys anywhere in the nav either.
        await expect
          .poll(() => page.locator("#setMenu").innerText(), { timeout: 10_000 })
          .not.toMatch(/web\.settings\./);
        // Visual reference: Advanced (section cards, no hidden disclosure).
        await openPanel(page, "advanced");
        await page.screenshot({ path: `${dir}/advanced-sections.png` });
        writeArtifacts(dir, "cfg-panels", { html: await page.content(), consoleErrors: errors });
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
        await openPanel(page, "general");
        const boolToggle = panelRow(page, "general", "auto-plan").locator(".toggle");
        const wasOn = await boolToggle.evaluate((el) => el.classList.contains("on"));
        await boolToggle.click();
        await expect.poll(() => configValue(baseUrl, "autoPlan"), { timeout: 10_000 }).toBe(!wasOn);
        await boolToggle.click();
        await expect.poll(() => configValue(baseUrl, "autoPlan"), { timeout: 10_000 }).toBe(wasOn);

        // int input + revert (advanced → retry section → max retries).
        await openPanel(page, "advanced");
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

        // list input + revert (agent → tools section → default tool tags).
        await openPanel(page, "agent");
        const listInput = panelRow(page, "agent", "default tool tags").locator("input");
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
        await openPanel(page, "advanced");
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
        await openPanel(page, "model");
        await page.locator('[data-panel="model"] .sec-add').click();
        const form = page.locator("#subHost .pform");
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
        await openPanel(page, "plugins");

        // MCP create through the nested dialog (stdio needs a command only).
        await page.locator('[data-panel="plugins"] button', { hasText: "add MCP server" }).click();
        const mcpForm = page.locator("#subHost .pform");
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
        const lspForm = page.locator("#subHost .pform");
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

  e2e(
    "settings search finds a deep key and navigates to its panel",
    async () => {
      const dir = artifactsDirFor("cfg-search");
      await withE2E(dir, async (_srv, { page, errors }: Launched) => {
        await openSettings(page);
        const search = page.locator("#setSearch");
        await search.fill("compaction");
        const results = page.locator("#setResults .set-result");
        await expect.poll(() => results.count(), { timeout: 10_000 }).toBeGreaterThan(0);
        // Result rows carry the human label, the owning panel and the raw key.
        await expect.poll(() => results.first().innerText(), { timeout: 10_000 }).toMatch(/compaction/i);
        // Picking a result switches to the owning panel and highlights the row.
        await results.first().click();
        await expect
          .poll(() => page.locator('[data-panel="context"] .row-flash').count(), { timeout: 10_000 })
          .toBeGreaterThan(0);
        await expect
          .poll(() => page.locator('[data-panel="context"]').isVisible(), { timeout: 5_000 })
          .toBe(true);
        // No-match state is explicit, not a blank list.
        await search.fill("zzz-no-such-setting");
        await expect
          .poll(() => page.locator("#setResults .set-results-empty").isVisible(), { timeout: 10_000 })
          .toBe(true);
        await search.fill("");
        await expect.poll(() => page.locator("#setMenu").isVisible(), { timeout: 10_000 }).toBe(true);
        await page.keyboard.press("Escape");

        writeArtifacts(dir, "cfg-search", { html: await page.content(), consoleErrors: errors });
        expect(errors).toEqual([]);
      });
    },
    180_000,
  );
});
