/**
 * Playwright e2e: web slash-commands from `HELP` (`src/modules/webui/commands.ts`).
 *
 * All of these run WITHOUT an LLM (pure dispatcher + config/registry), so the
 * isolated dummy-provider server answers them deterministically. Each command
 * is typed into the real composer and its SSE `command` output (`.cmdout`
 * lines) is asserted. State-mutating checks revert their change.
 *
 * Out of scope here (own files): /clear + /new UX (chat-tabs), provider
 * add-form (provider-dialog), /export with history (chat-tabs).
 *
 * Run ONLY on explicit request: `bun run test:e2e`.
 */
import { describe, expect } from "vitest";
import type { Page } from "playwright";
import {
  e2e,
  withE2E,
  waitForLiveTab,
  sendLine,
  waitCmdOut,
  apiGet,
  apiPost,
  firstSession,
  activeProvider,
  artifactsDirFor,
  writeArtifacts,
  type Launched,
} from "./web-helpers";

async function configValue(baseUrl: string, dotted: string): Promise<string> {
  const { json } = await apiGet(baseUrl, "/api/config");
  const cfg = (json as { config?: Record<string, unknown> }).config ?? {};
  return String(
    dotted.split(".").reduce<unknown>((o, k) => ((o as Record<string, unknown>) ?? {})[k], cfg),
  );
}

async function finish(dir: string, page: Page, errors: string[]): Promise<void> {
  await page.screenshot({ path: `${dir}/commands.png` });
  writeArtifacts(dir, "commands", { html: await page.content(), consoleErrors: errors });
  expect(errors).toEqual([]);
}

describe("web e2e: slash commands", () => {
  e2e(
    "read-only info commands answer in the feed",
    async () => {
      const dir = artifactsDirFor("commands-info");
      await withE2E(dir, async (srv, { page, errors }: Launched) => {
        await waitForLiveTab(page);
        for (const [line, marker] of [
          ["/help", "list web commands"],
          ["/status", "tok"],
          ["/config nosuchkey", "unknown key: nosuchkey"],
          ["/model list", "current:"],
          ["/reasoning", "reasoning:"],
          ["/context", "context:"],
          ["/nosuchcmd", "unknown command: nosuchcmd"],
        ] as Array<[string, string]>) {
          await sendLine(page, line);
          await waitCmdOut(page, marker);
        }
        await finish(dir, page, errors);
      });
    },
    180_000,
  );

  e2e(
    "verbosity and model switch apply and revert",
    async () => {
      const dir = artifactsDirFor("commands-switch");
      await withE2E(dir, async (srv, { page, errors }: Launched) => {
        await waitForLiveTab(page);
        const origVerbosity = await configValue(srv.baseUrl, "ui.verbosity");
        const flipped = origVerbosity === "verbose" ? "quiet" : "verbose";
        await sendLine(page, `/verbose ${flipped}`);
        await waitCmdOut(page, `ui.verbosity = ${flipped}`);
        await sendLine(page, `/verbose ${origVerbosity}`);
        await waitCmdOut(page, `ui.verbosity = ${origVerbosity}`);

        const origModel = await configValue(srv.baseUrl, "model");
        await sendLine(page, "/model use e2e-probe-model");
        await waitCmdOut(page, "model = e2e-probe-model");
        await sendLine(page, `/model use ${origModel}`);
        await waitCmdOut(page, `model = ${origModel}`);
        await finish(dir, page, errors);
      });
    },
    180_000,
  );

  e2e(
    "memory and session round-trips",
    async () => {
      const dir = artifactsDirFor("commands-memory-session");
      await withE2E(dir, async (srv, { page, errors }: Launched) => {
        const { baseUrl } = srv;
        await waitForLiveTab(page);

        await sendLine(page, "/memory set e2e_key e2e value");
        await waitCmdOut(page, "saved e2e_key=e2e value");
        await sendLine(page, "/memory unset e2e_key");
        await waitCmdOut(page, "removed e2e_key");

        const first = await firstSession(baseUrl);
        await sendLine(page, "/session list");
        await waitCmdOut(page, first.name);
        await sendLine(page, `/session use ${first.id.slice(0, 12)}`);
        await waitCmdOut(page, "active session:");
        await finish(dir, page, errors);
      });
    },
    180_000,
  );

  e2e(
    "provider switch round-trip; locale flips server dict; empty export",
    async () => {
      const dir = artifactsDirFor("commands-provider");
      await withE2E(dir, async (srv, { page, errors }: Launched) => {
        const { baseUrl } = srv;
        await waitForLiveTab(page);

        const origProvider = await activeProvider(baseUrl);
        const added = await apiPost(baseUrl, "/api/providers", {
          type: "openai-compat",
          label: "e2e-second",
          baseUrl: "http://127.0.0.1:9/v1",
        });
        expect(added.status).toBe(200);
        await sendLine(page, "/provider list");
        await waitCmdOut(page, "e2e-second");
        await sendLine(page, "/provider use e2e-second");
        await waitCmdOut(page, "provider.active = e2e-second");
        await sendLine(page, `/provider use ${origProvider}`);
        await waitCmdOut(page, `provider.active = ${origProvider}`);
        expect(
          await fetch(`${baseUrl}/api/providers/${encodeURIComponent("e2e-second")}`, {
            method: "DELETE",
          }),
        ).toHaveProperty("status", 200);

        await sendLine(page, "/config locale ru");
        await waitCmdOut(page, "locale = ru");
        expect(((await apiGet(baseUrl, "/api/i18n")).json as { locale?: string }).locale).toBe(
          "ru",
        );
        await sendLine(page, "/config locale en");
        await waitCmdOut(page, "locale = en");

        await sendLine(page, "/export");
        await waitCmdOut(page, "nothing to export");
        await finish(dir, page, errors);
      });
    },
    180_000,
  );

  e2e(
    "slash autocomplete popup lists server commands",
    async () => {
      const dir = artifactsDirFor("cmdk");
      await withE2E(dir, async (_srv, { page, errors }: Launched) => {
        await page.fill("#inp", "/mod");
        await page.waitForSelector("#cmdk-list:not([hidden])", { timeout: 15_000 });
        const items = await page.locator(".cmdk-item").allInnerTexts();
        expect(items.some((t) => t.includes("/model"))).toBe(true);
        await page.keyboard.press("Escape");
        await page.waitForSelector("#cmdk-list:not([hidden])", {
          state: "hidden",
          timeout: 10_000,
        });
        expect(errors).toEqual([]);
      });
    },
    120_000,
  );
});
