/**
 * Playwright e2e: settings modal (all 11 panels), theme, locale switch,
 * security toggles, context window write + revert, memory UI, MCP toggle,
 * model panel offline placeholder.
 *
 * Everything runs against the isolated dummy-provider server; writes land in
 * the temp `MMA_CONFIG_DIR` and mutating checks revert their change.
 *
 * Run ONLY on explicit request: `bun run test:e2e`.
 */
import { describe, expect } from "vitest";
import {
  e2e,
  withE2E,
  sendLine,
  waitCmdOut,
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
  "persistence",
  "retry",
  "lists",
  "ui",
  "memory",
  "skills",
  "plugins",
  "security",
  "advanced",
  "advanced-json",
];

async function openSettings(page: Launched["page"]): Promise<void> {
  await page.click("#openSettings");
  await page.waitForSelector("#overlay.open", { timeout: 10_000 });
}

async function configValue(baseUrl: string, dotted: string): Promise<unknown> {
  const { json } = await apiGet(baseUrl, "/api/config");
  const cfg = (json as { config?: Record<string, unknown> }).config ?? {};
  return dotted.split(".").reduce<unknown>((o, k) => ((o as Record<string, unknown>) ?? {})[k], cfg);
}

describe("web e2e: settings", () => {
  e2e(
    "all panels render; theme switches the class",
    async () => {
      const dir = artifactsDirFor("settings-panels");
      await withE2E(dir, async (_srv, { page, errors }: Launched) => {
        await openSettings(page);

        // Every registered section renders a non-empty panel.
        for (const name of PANELS) {
          await page.click(`#setMenu [data-p="${name}"]`);
          const panel = page.locator(`[data-panel="${name}"]`);
          await expect.poll(() => panel.innerText(), { timeout: 10_000 }).not.toHaveLength(0);
        }
        await page.screenshot({ path: `${dir}/panels-model.png` });

        // Theme: light adds the class, dark removes it.
        await page.click('#setMenu [data-p="ui"]');
        await page.locator('[data-panel="ui"] button', { hasText: "light" }).click();
        await page.waitForFunction(() => document.body.classList.contains("light"), {
          timeout: 10_000,
        });
        await page.locator('[data-panel="ui"] button', { hasText: "dark" }).click();
        await page.waitForFunction(() => !document.body.classList.contains("light"), {
          timeout: 10_000,
        });
        writeArtifacts(dir, "settings-panels", {
          html: await page.content(),
          consoleErrors: errors,
        });
        expect(errors).toEqual([]);
      });
    },
    180_000,
  );

  e2e(
    "locale switch re-renders the chrome both ways",
    async () => {
      const dir = artifactsDirFor("settings-locale");
      await withE2E(dir, async (_srv, { page, errors }: Launched) => {
        await openSettings(page);
        // Locale through the General panel enum: the chrome re-renders in
        // Russian (the slash path only flips the server value — by design it
        // has no chrome-reload event; the UI path does it via postConfig).
        const titleBefore = await page.textContent("#settingsTitle");
        await page.click('#setMenu [data-p="general"]');
        // Locale is the first row; labels localize after the switch, so the
        // way back is by value, not visible text. (Enum renders as <select>
        // since full-config-surfaces; was `.seg button` before.)
        const localeSel = () =>
          page.locator('[data-panel="general"] .row').first().locator("select");
        await localeSel().selectOption("ru");
        await expect
          .poll(() => page.textContent("#settingsTitle"), { timeout: 15_000 })
          .not.toBe(titleBefore);
        expect(await page.evaluate(() => document.documentElement.lang)).toBe("ru");
        await localeSel().selectOption("en");
        await expect
          .poll(() => page.textContent("#settingsTitle"), { timeout: 15_000 })
          .toBe(titleBefore);
        writeArtifacts(dir, "settings-locale", {
          html: await page.content(),
          consoleErrors: errors,
        });
        expect(errors).toEqual([]);
      });
    },
    180_000,
  );

  e2e(
    "security toggle and context window write and revert",
    async () => {
      const dir = artifactsDirFor("settings-writes");
      await withE2E(dir, async (srv, { page, errors }: Launched) => {
        const { baseUrl } = srv;
        await openSettings(page);

        // Security toggle flips the persisted value; flip back afterwards.
        // (The modal is still open from the locale check above.)
        await page.click('#setMenu [data-p="security"]');
        const toggle = page.locator('[data-panel="security"] .toggle').first();
        const wasOn = await toggle.evaluate((el) => el.classList.contains("on"));
        await toggle.click();
        await expect
          .poll(() => configValue(baseUrl, "security.enabled"), { timeout: 10_000 })
          .toBe(!wasOn);
        await toggle.click();
        await expect
          .poll(() => configValue(baseUrl, "security.enabled"), { timeout: 10_000 })
          .toBe(wasOn);

        // Context window write + revert through the number input.
        await page.click('#setMenu [data-p="context"]');
        const origCtx = Number(await configValue(baseUrl, "contextWindow"));
        const probe = origCtx === 32768 ? 65536 : 32768;
        const input = page.locator('[data-panel="context"] input[type="number"]').first();
        await input.fill(String(probe));
        await input.press("Tab");
        await expect
          .poll(() => configValue(baseUrl, "contextWindow"), { timeout: 10_000 })
          .toBe(probe);
        await input.fill(String(origCtx));
        await input.press("Tab");
        await expect
          .poll(() => configValue(baseUrl, "contextWindow"), { timeout: 10_000 })
          .toBe(origCtx);
        await page.keyboard.press("Escape");

        writeArtifacts(dir, "settings-writes", {
          html: await page.content(),
          consoleErrors: errors,
        });
        expect(errors).toEqual([]);
      });
    },
    180_000,
  );

  e2e(
    "memory UI add and forget",
    async () => {
      const dir = artifactsDirFor("settings-memory");
      await withE2E(dir, async (_srv, { page, errors }: Launched) => {
        await openSettings(page);
        await page.click('#setMenu [data-p="memory"]');
        await page.locator('[data-panel="memory"] .mem-add select').selectOption("facts");
        await page.locator('[data-panel="memory"] .mem-add input').fill("e2e ui memory probe");
        await page.locator('[data-panel="memory"] .mem-add button').click();
        await page.waitForSelector(".mem-entry", { timeout: 10_000 });
        expect(await page.locator(".mem-entry").allInnerTexts()).toEqual(
          expect.arrayContaining([expect.stringContaining("e2e ui memory probe")]),
        );
        await page.locator(".mem-entry .mem-del").first().click();
        await page.waitForSelector(".mem-entry", { state: "hidden", timeout: 10_000 });
        writeArtifacts(dir, "settings-memory", {
          html: await page.content(),
          consoleErrors: errors,
        });
        expect(errors).toEqual([]);
      });
    },
    180_000,
  );

  e2e(
    "model panel renders; MCP toggle flips and reverts; skills panel non-blank",
    async () => {
      const dir = artifactsDirFor("settings-data");
      await withE2E(dir, async (srv, { page, errors }: Launched) => {
        const { baseUrl } = srv;
        await openSettings(page);

        // Model panel renders something: the live catalog when this box serves
        // models, the offline placeholder otherwise. Either is a valid panel.
        await page.click('#setMenu [data-p="model"]');
        await expect
          .poll(() => page.locator('[data-panel="model"]').innerText(), { timeout: 15_000 })
          .not.toHaveLength(0);

        // MCP toggle flips the persisted flag; flip back afterwards.
        await page.click('#setMenu [data-p="plugins"]');
        const mcpToggle = page.locator(".list-line .toggle").first();
        await mcpToggle.waitFor({ timeout: 10_000 });
        const wasOn = await mcpToggle.evaluate((el) => el.classList.contains("on"));
        const mcpStatus = async (): Promise<string> => {
          const body = (await apiGet(baseUrl, "/api/plugins")).json as {
            mcp?: Array<{ status?: string }>;
          };
          return body.mcp?.[0]?.status ?? "";
        };
        await mcpToggle.click();
        await expect.poll(mcpStatus, { timeout: 15_000 }).toBe(wasOn ? "disabled" : "enabled");
        await page.locator(".list-line .toggle").first().click();
        await expect.poll(mcpStatus, { timeout: 15_000 }).toBe(wasOn ? "enabled" : "disabled");

        // Skills panel renders something (list or placeholder), never blank.
        await page.click('#setMenu [data-p="skills"]');
        await expect
          .poll(() => page.locator('[data-panel="skills"]').innerText(), { timeout: 10_000 })
          .not.toHaveLength(0);
        await page.screenshot({ path: `${dir}/settings-data.png` });

        writeArtifacts(dir, "settings-data", {
          html: await page.content(),
          consoleErrors: errors,
        });
        expect(errors).toEqual([]);
      });
    },
    240_000,
  );
});
