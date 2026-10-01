/**
 * File rows are always expanded — isolated `MMA_CONFIG_DIR`
 * Playwright check, see `./web-harness.ts` / `./web-helpers.ts`.
 *
 * Verifies the served assets render one quiet `filerow` per file-tool call
 * with a full root-relative path link (no `.filecard` box, no collapsed
 * `.filegroup`): consecutive rows stay an expanded list, never a chevron group.
 */
import { describe, expect } from "vitest";
import { join } from "node:path";
import {
  e2e,
  withE2E,
  artifactsDirFor,
  writeArtifacts,
} from "./web-helpers";
import { expectNonVirgin } from "./web-harness";

describe("web e2e (isolated MMA_CONFIG_DIR)", () => {
  e2e(
    "file rows always expand with full root-relative links, no group",
    async () => {
      const dir = artifactsDirFor("filecard");
      await withE2E(dir, async (srv, { page, errors }) => {
        await expectNonVirgin(srv.baseUrl);

        const js = await page.evaluate(async () => {
          const r = await fetch("/js/feed.js");
          return await r.text();
        });
        expect(js).toContain('"filerow');
        expect(js).toContain("displayPathFromRoot");
        expect(js).not.toContain("maybeGroupFilerow");
        expect(js).not.toContain("filegroup");
        expect(js).not.toContain("fc-open");
        expect(js).not.toContain("download=1");
        expect(js).not.toContain("fc-hint");

        const css = await page.evaluate(async () => {
          const r = await fetch("/styles.css");
          return r.ok ? await r.text() : "";
        });
        expect(css).toContain(".filerow");
        expect(css).not.toContain(".filegroup");
        expect(css).not.toContain(".filecard");

        // NOTE: samples live in an isolated #probe container, not #msgs —
        // the app's state poll re-renders the feed and would detach them.
        await page.evaluate(() => {
          document.querySelector("#probe")?.remove();
          const probe = document.createElement("div");
          probe.id = "probe";
          probe.style.cssText =
            "padding:24px;max-width:640px;";
          probe.innerHTML = "<h3>filecard probe</h3>";
          document.body.appendChild(probe);
          const paths = [
            "src/modules/webui/assets/js/feed.js",
            "src/modules/webui/assets/js/sidebar.js",
          ];
          for (const p of paths) {
            const row = document.createElement("div");
            row.className = "filerow recon";
            row.innerHTML = `<span class="g">◇</span><span class="lab">Reading file</span><span class="sep"> · </span><a class="path" href="/api/file?path=${encodeURIComponent(p)}">${p}</a><button class="copy-btn" aria-label="copy path"><svg class="svg-icon" viewBox="0 0 24 24"></svg></button><span class="st"> ✓</span>`;
            probe.appendChild(row);
          }
        });

        const state = await page.evaluate(() => {
          const rows = Array.from(document.querySelectorAll("#probe .filerow")) as HTMLElement[];
          const links = Array.from(document.querySelectorAll('#probe .filerow a.path')) as HTMLAnchorElement[];
          return {
            rows: rows.length,
            groups: document.querySelectorAll("#probe .filegroup").length,
            hidden: document.querySelectorAll("#probe .items.hidden").length,
            linkTexts: links.map((a) => a.textContent),
            hrefs: links.map((a) => a.getAttribute("href")),
          };
        });
        expect(state.rows).toBe(2);
        expect(state.groups).toBe(0);
        expect(state.hidden).toBe(0);
        expect(state.linkTexts).toEqual([
          "src/modules/webui/assets/js/feed.js",
          "src/modules/webui/assets/js/sidebar.js",
        ]);
        for (const href of state.hrefs) {
          expect(href).toMatch(/^\/api\/file\?path=/);
        }

        const style = await page.evaluate(() => {
          const el = document.querySelector(".filerow") as HTMLElement;
          const cs = getComputedStyle(el);
          const btn = el.querySelector(".copy-btn") as HTMLElement;
          return {
            bg: cs.backgroundColor,
            borderStyle: cs.borderStyle,
            copyIdle: getComputedStyle(btn).opacity,
          };
        });
        expect(["rgba(0, 0, 0, 0)", "transparent"]).toContain(style.bg);
        expect(["none", ""]).toContain(style.borderStyle);
        expect(style.copyIdle).toBe("0");

        await page.hover(".filerow .copy-btn");
        await expect
          .poll(
            async () =>
              page.evaluate(
                () =>
                  getComputedStyle(
                    document.querySelector(
                      ".filerow .copy-btn",
                    ) as HTMLElement,
                  ).opacity,
              ),
            { timeout: 5000 },
          )
          .toBe("1");
        await page.locator("#probe").screenshot({ path: join(dir, "filerow-quiet.png") });

        expect(await page.locator(".filecard").count()).toBe(0);
        expect(await page.locator(".filegroup").count()).toBe(0);
        writeArtifacts(dir, "filecard", {
          html: await page.content(),
          consoleErrors: errors,
          extra: { style, state },
        });
        expect(errors).toEqual([]);
      });
    },
    120_000,
  );
});
