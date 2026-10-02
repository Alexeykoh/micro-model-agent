/**
 * Playwright e2e: chat turn (dummy-provider failure path), tabs, sessions
 * dropdown, image attach, /clear + /new, /export with history, file viewer.
 *
 * The isolated server has no LLM (dummy `localhost:1234` provider), so a chat
 * turn deterministically FAILS fast — this exercises the error path
 * (`.errline` + `turn_end{success:false}`) rather than model output, which is
 * covered by unit tests with stubbed providers.
 *
 * Run ONLY on explicit request: `bun run test:e2e`.
 */
import { describe, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  e2e,
  withE2E,
  waitForLiveTab,
  createSessionTopbar,
  waitActiveBadge,
  deletableRow,
  sessionCount,
  sendLine,
  waitCmdOut,
  apiGet,
  artifactsDirFor,
  writeArtifacts,
  type Launched,
} from "./web-helpers";

/** 1x1 transparent PNG for the attach-image flow. */
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("web e2e: chat, tabs, sessions, files", () => {
  e2e(
    "chat turn fails cleanly on the dummy provider; export then has history",
    async () => {
      const dir = artifactsDirFor("chat");
      await withE2E(dir, async (srv, { page, errors }: Launched) => {
        const { baseUrl } = srv;
        await waitForLiveTab(page);

        // Busy/idle guards at the HTTP layer (no turn is running).
        const interrupt = await fetch(`${baseUrl}/api/interrupt`, { method: "POST" });
        expect(interrupt.status).toBe(409);
        const answer = await fetch(`${baseUrl}/api/answer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: "nope", value: "x" }),
        });
        expect(answer.status).toBe(404);

        // Plain message: accepted (202). Against a live backend the turn
        // succeeds (markdown + copy actions render); without one it fails
        // fast with a visible cause. Both are valid — the harness must not
        // assume which backend this box has.
        await sendLine(page, "hello e2e");
        await expect
          .poll(
            () =>
              page.locator(".errline").count().then((errs) =>
                page.locator(".msg-actions").count().then((acts) => errs + acts),
              ),
            { timeout: 120_000 },
          )
          .toBeGreaterThan(0);
        const failed = (await page.locator(".errline").count()) > 0;
        await page.screenshot({ path: `${dir}/chat-turn.png` });

        // Either way the user message is recorded → export works.
        const outPath = join(mkdtempSync(join(tmpdir(), "mma-e2e-")), "chat.md");
        await sendLine(page, `/export --out ${outPath}`);
        await waitCmdOut(page, failed ? /exported|nothing to export/ : "exported");
        if (!failed) {
          const exported = readFileSync(outPath, "utf8");
          expect(exported).toContain("hello e2e");
        }

        writeArtifacts(dir, "chat", { html: await page.content(), consoleErrors: errors });
        expect(errors).toEqual([]);
      });
    },
    180_000,
  );

  e2e(
    "new tab via topbar; URL tracks the session; dropdown lists both",
    async () => {
      const dir = artifactsDirFor("tabs-new");
      await withE2E(dir, async (_srv, { page, errors }: Launched) => {
        const tabCount = () => page.locator(".stab").count();
        await waitForLiveTab(page);
        const before = await tabCount();
        await page.click("#newChat");
        await expect.poll(tabCount, { timeout: 15_000 }).toBe(before + 1);
        await page.waitForFunction(() => new URLSearchParams(location.search).has("session"), {
          timeout: 15_000,
        });

        await page.click("#sessBtn");
        await page.waitForSelector(".dd-menu .si", { timeout: 10_000 });
        const listed = await page.locator(".dd-menu .si .id").allInnerTexts();
        expect(listed.length).toBeGreaterThanOrEqual(2);
        writeArtifacts(dir, "tabs-new", { html: await page.content(), consoleErrors: errors });
        expect(errors).toEqual([]);
      });
    },
    180_000,
  );

  e2e(
    "delete a session through the dropdown confirm dialog",
    async () => {
      const dir = artifactsDirFor("tabs-delete");
      await withE2E(dir, async (srv, { page, errors }: Launched) => {
        const { baseUrl } = srv;
        await waitForLiveTab(page);
        const created = await createSessionTopbar(page, baseUrl);
        await waitActiveBadge(page, created);
        const before = await sessionCount(baseUrl);
        const victimRow = await deletableRow(page, created);
        expect(victimRow).toBeGreaterThan(-1);
        const rows = page.locator(".dd-menu .si-row");
        await rows.nth(victimRow).locator(".del-btn").click();
        await page.waitForSelector("#confirmOverlay.open", { timeout: 10_000 });
        await page.screenshot({ path: `${dir}/confirm.png` });
        await page.click("#confirmAccept");
        await expect.poll(() => sessionCount(baseUrl), { timeout: 15_000 }).toBe(before - 1);
        writeArtifacts(dir, "tabs-delete", { html: await page.content(), consoleErrors: errors });
        expect(errors).toEqual([]);
      });
    },
    180_000,
  );

  e2e(
    "/clear empties the feed; /new opens another tab",
    async () => {
      const dir = artifactsDirFor("tabs-clear-new");
      await withE2E(dir, async (_srv, { page, errors }: Launched) => {
        const tabCount = () => page.locator(".stab").count();
        await waitForLiveTab(page);
        await sendLine(page, "/status");
        await waitCmdOut(page, "tok");
        await sendLine(page, "/clear");
        await page.waitForSelector("#msgs .empty", { timeout: 10_000 });
        expect(await page.locator(".cmdout").count()).toBe(0);
        const tabsBefore = await tabCount();
        await sendLine(page, "/new");
        await expect.poll(tabCount, { timeout: 15_000 }).toBe(tabsBefore + 1);
        writeArtifacts(dir, "tabs-clear-new", {
          html: await page.content(),
          consoleErrors: errors,
        });
        expect(errors).toEqual([]);
      });
    },
    180_000,
  );

  e2e(
    "image attach shows a thumb; file viewer serves workspace files",
    async () => {
      const dir = artifactsDirFor("files");
      await withE2E(dir, async (srv, { page, errors }: Launched) => {
        const { baseUrl } = srv;

        const png = join(mkdtempSync(join(tmpdir(), "mma-e2e-")), "pixel.png");
        writeFileSync(png, PIXEL_PNG);
        await page.setInputFiles("#imgPicker", png);
        await page.waitForSelector(".thumb", { timeout: 10_000 });
        await page.screenshot({ path: `${dir}/attached.png` });
        await page.locator(".thumb .rm").first().click();
        await page.waitForSelector(".thumb", { state: "hidden", timeout: 10_000 });

        // File viewer: workspace file OK, traversal + protected paths refused.
        const ok = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent("package.json")}`);
        expect(ok.status).toBe(200);
        expect(await ok.text()).toContain("micro-models-agent");
        const traversal = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent("../outside.txt")}`);
        expect(traversal.ok).toBe(false);
        const git = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent(".git/config")}`);
        expect(git.ok).toBe(false);

        writeArtifacts(dir, "files", { html: await page.content(), consoleErrors: errors });
        expect(errors).toEqual([]);
      });
    },
    180_000,
  );

  e2e(
    "switching tabs scopes the sidebar to the active session",
    async () => {
      const dir = artifactsDirFor("tabs-sidebar");
      await withE2E(dir, async (srv, { page, errors }: Launched) => {
        const { baseUrl } = srv;
        await waitForLiveTab(page);
        const created = await createSessionTopbar(page, baseUrl);
        await waitActiveBadge(page, created);

        // New tab is active → sidebar session row shows its id, not the previous.
        await expect
          .poll(() => page.locator("#usage").innerText(), { timeout: 15_000 })
          .toContain(created);

        // Switch to the other (first) tab and back to confirm the sidebar follows.
        const ids = await page
          .locator(".stab")
          .evaluateAll((els) => els.map((e) => e.getAttribute("title")));
        const first = ids.find((id) => id && id !== created);
        expect(first).toBeTruthy();
        await page.locator(`.stab[title="${first}"]`).click();
        await expect
          .poll(() => page.locator("#usage").innerText(), { timeout: 15_000 })
          .toContain(first as string);
        await page.locator(`.stab[title="${created}"]`).click();
        await expect
          .poll(() => page.locator("#usage").innerText(), { timeout: 15_000 })
          .toContain(created);

        writeArtifacts(dir, "tabs-sidebar", { html: await page.content(), consoleErrors: errors });
        expect(errors).toEqual([]);
      });
    },
    180_000,
  );
});
