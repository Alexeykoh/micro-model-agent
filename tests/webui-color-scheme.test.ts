/**
 * U10: тема сообщается браузеру — `color-scheme` на `<html>` и
 * `<meta name="theme-color">`, и то и другое меняется при смене режима.
 * Без этого нативные скроллбары и адресная строка на мобильном остаются
 * светлыми в тёмной теме.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();
const HTML = readFileSync(join(ROOT, "src/modules/webui/assets/index.html"), "utf-8");
const THEME_TS = readFileSync(
  join(ROOT, "src/modules/webui/assets/js/settings/theme.ts"),
  "utf-8",
);

describe("web ui color scheme (U10)", () => {
  it("declares theme-color before the first paint", () => {
    expect(HTML).toMatch(/<meta name="theme-color" content="#[0-9a-f]{6}">/i);
  });

  it("the pre-paint script sets colorScheme and theme-color", () => {
    expect(HTML).toMatch(/documentElement\.style\.colorScheme\s*=/);
    expect(HTML).toMatch(/meta\[name="theme-color"\]/);
  });

  it("runtime theme switches keep the browser in sync", () => {
    expect(THEME_TS).toMatch(/documentElement\.style\.colorScheme\s*=/);
    expect(THEME_TS).toMatch(/theme-color/);
  });
});
