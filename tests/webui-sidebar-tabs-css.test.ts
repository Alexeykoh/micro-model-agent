// Гарант адаптивных вкладок сайдбара (TODO §1.13, явное требование):
// подписи включаются контейнерным запросом по ширине полосы; при нехватке
// места — только иконки; без обрезания (нет ellipsis) и без переноса.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const css = readFileSync(join(root, "src/modules/webui/assets/styles.css"), "utf8");
const compact = readFileSync(
  join(root, "src/modules/webui/assets/js/sidebar/compact-tabs.ts"),
  "utf8",
);

describe("sidebar tabs: container-adaptive labels", () => {
  it("the strip is a size container and never wraps", () => {
    expect(css).toMatch(/\.sb-tabs\s*\{[^}]*container:\s*sbtabs\s*\/\s*inline-size/);
    expect(css).toMatch(/\.sb-tabs\s*\{[^}]*flex-wrap:\s*nowrap/);
  });

  it("labels are hidden by default and gated by @container thresholds", () => {
    expect(css).toMatch(/\.sb-lab\s*\{[^}]*display:\s*none/);
    // Никакого обрезания: ellipsis на подписи вкладок запрещён.
    expect(css).not.toMatch(/\.sb-lab\s*\{[^}]*text-overflow/);
    const collapsed = css.match(/@container sbtabs \(min-width: \d+px\)\s*\{\s*\.sb-tabs:not\(\.sb-expanded\) \.sb-lab \{\s*display:\s*inline/);
    const expanded = css.match(/@container sbtabs \(min-width: \d+px\)\s*\{\s*\.sb-tabs\.sb-expanded \.sb-lab \{\s*display:\s*inline/);
    expect(collapsed).not.toBeNull();
    expect(expanded).not.toBeNull();
    // Порог раскрытого набора обязан быть строго больше свёрнутого:
    // десять вкладок с текстом вмещаются реже, чем четыре.
    const n1 = Number(collapsed?.[0].match(/min-width: (\d+)px/)?.[1] ?? 0);
    const n2 = Number(expanded?.[0].match(/min-width: (\d+)px/)?.[1] ?? 0);
    expect(n2).toBeGreaterThan(n1);
  });

  it("tabs no longer reserve a fixed min-width (icon-only must shrink)", () => {
    expect(css).toMatch(/\.sb-tab\s*\{[^}]*flex:\s*0 0 auto/);
    expect(css).not.toMatch(/\.sb-tab\s*\{[^}]*min-width:/);
  });

  it("compact-tabs toggles sb-expanded on the strip (the CSS hook)", () => {
    expect(compact).toMatch(/classList\.toggle\("sb-expanded",\s*expanded\)/);
  });
});
