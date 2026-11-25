import { describe, expect, it } from "vitest";
import { loadAssets } from "../src/modules/webui/assets";
import { SECURITY_HEADERS } from "../src/modules/webui/auth";
import { STATIC_ASSETS } from "../src/modules/webui/static-assets";

/** INV: CSP веб-поверхности не должна разрешать инлайновые скрипты. */
describe("web UI CSP без инлайновых скриптов", () => {
  it("script-src не содержит unsafe-inline", () => {
    const csp = SECURITY_HEADERS["Content-Security-Policy"] ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it("инлайновых <script> в index.html нет, тема грузится внешним файлом", () => {
    const html = loadAssets().html;
    expect(html).toContain('<script src="/theme.js"></script>');
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/gi)].map((m) => m[0]);
    expect(inline).toEqual([]);
  });

  it("theme.js грузится и отдаётся как статический ассет", () => {
    const assets = loadAssets();
    expect(assets.themeJs).toContain("mma-theme");
    expect(STATIC_ASSETS["/theme.js"]).toMatchObject({
      type: "text/javascript; charset=utf-8",
      key: "themeJs",
    });
  });
});
