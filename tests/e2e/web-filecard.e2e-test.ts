/**
 * Filecard redesign (D quiet line + E grouping) — isolated `MMA_CONFIG_DIR`
 * Playwright check, see `./web-harness.ts` / `./web-helpers.ts`.
 *
 * Verifies the served assets carry the new markup (no `.filecard` box) and
 * renders sample rows with the real classes for a visual proof + interaction
 * (hover reveals copy icon, chevron expands the group).
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
    "filecard redesign: quiet filerow lines, no box, group expands",
    async () => {
      const dir = artifactsDirFor("filecard");
      await withE2E(dir, async (srv, { page, errors }) => {
        await expectNonVirgin(srv.baseUrl);

        const js = await page.evaluate(async () => {
          const r = await fetch("/js/feed.js");
          return await r.text();
        });
        expect(js).toContain('"filerow');
        expect(js).toContain("chevron-down");
        expect(js).toContain("maybeGroupFilerow");
        expect(js).toContain("previousElementSibling");
        expect(js).not.toContain("fc-open");
        expect(js).not.toContain("download=1");
        expect(js).not.toContain("fc-hint");

        const css = await page.evaluate(async () => {
          const r = await fetch("/styles.css");
          return r.ok ? await r.text() : "";
        });
        expect(css).toContain(".filerow");
        expect(css).toContain(".filegroup");
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
          const row = document.createElement("div");
          row.className = "filerow recon";
          row.innerHTML = `<span class="g">◇</span><span class="lab">Reading file</span><span class="sep"> · </span><a class="path" href="#" onclick="return false">feed.js</a><span class="tail"> · src/modules/webui/assets/js</span><button class="copy-btn" aria-label="copy path"><svg class="svg-icon" viewBox="0 0 24 24"></svg></button><span class="st"> ✓</span>`;
          probe.appendChild(row);
          const g = document.createElement("div");
          g.className = "filegroup";
          g.innerHTML = `<button class="head" aria-expanded="false"><span class="g">│ </span><span class="count">2 files</span><span class="ok"> ✓</span></button><div class="items hidden"><div class="filerow recon"><span class="g">◇</span><span class="lab">Reading file</span><span class="sep"> · </span><a class="path" href="#" onclick="return false">sidebar.js</a></div></div>`;
          const head = g.querySelector(".head") as HTMLButtonElement;
          head.addEventListener("click", () => {
            const open = g.dataset.open === "1";
            g.dataset.open = open ? "" : "1";
            head.setAttribute("aria-expanded", open ? "false" : "true");
            g.querySelector(".items")!.classList.toggle("hidden", open);
          });
          probe.appendChild(g);
        });

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

        await page.click(".filegroup .head");
        await expect
          .poll(async () =>
            page.evaluate(
              () =>
                document
                  .querySelector(".filegroup .head")!
                  .getAttribute("aria-expanded"),
            ),
          )
          .toBe("true");
        const expanded = await page.evaluate(() => ({
          open: (document.querySelector(".filegroup") as HTMLElement).dataset
            .open,
          hidden: document
            .querySelector(".filegroup .items")!
            .classList.contains("hidden"),
        }));
        expect(expanded.open).toBe("1");
        expect(expanded.hidden).toBe(false);
        await page.locator("#probe").screenshot({ path: join(dir, "filegroup-open.png") });

        expect(await page.locator(".filecard").count()).toBe(0);
        writeArtifacts(dir, "filecard", {
          html: await page.content(),
          consoleErrors: errors,
          extra: { style, expanded },
        });
        expect(errors).toEqual([]);
      });
    },
    120_000,
  );
});
