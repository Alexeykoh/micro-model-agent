import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectFiles } from "../helpers/import-graph";

/**
 * Landing-page accuracy gate.
 *
 * `gh-pages/` is a hand-written static site with no build step, so its copy
 * drifts from the code silently (that is exactly how a removed feature stayed
 * on the page for three releases). The version is already injected at deploy
 * time; this gate covers the facts that are still hard-coded: removed feature
 * surfaces, the mascot state set, always-on tools, service routes,
 * documentation links and i18n key symmetry.
 *
 * The page is published as-is, so a red test is the only thing standing
 * between a stale claim and a visitor.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PAGES = join(REPO_ROOT, "gh-pages");
const HTML = readFileSync(join(PAGES, "index.html"), "utf8");
const I18N_SRC = readFileSync(join(PAGES, "i18n.js"), "utf8");

type Dict = Record<string, string>;
interface LandingWindow {
  LP_I18N: { en: Dict; ru: Dict };
}
const landingWindow: LandingWindow = { LP_I18N: { en: {}, ru: {} } };
new Function("window", I18N_SRC)(landingWindow);
const EN = landingWindow.LP_I18N.en;
const RU = landingWindow.LP_I18N.ru;
const COPY = `${HTML}\n${I18N_SRC}`;

/** Standalone word, so `mode`/`model` stay innocent. */
const REMOVED_WORD_RE = /(^|[^A-Za-z0-9_])moe([^A-Za-z0-9_]|$)/i;

/** Config keys, tool names and prose that belonged to a removed subsystem. */
const REMOVED_TOKENS = [
  "Mixture of Experts",
  "moe.",
  "moe.enabled",
  "moe.maxReplanCycles",
  "orchestrator.model",
  "moe_plan",
  "moe_subtask",
  "MoEPlan",
];

/** Tool names live in `src/tools` and in modules — scan the whole tree once. */
let cachedSrc: string | null = null;
function srcText(): string {
  if (cachedSrc === null) {
    cachedSrc = collectFiles(join(REPO_ROOT, "src"), REPO_ROOT, [".ts", ".tsx"])
      .map((file) => file.text)
      .join("\n");
  }
  return cachedSrc;
}

function faceStates(): string[] {
  const loader = readFileSync(
    join(REPO_ROOT, "src/modules/webui/assets/js/loader.ts"),
    "utf-8",
  );
  const union = loader.match(/export type FaceState\s*=([\s\S]*?);/);
  if (!union) throw new Error("landing-accuracy: FaceState union not found");
  return [...union[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
}

function pageStates(): string[] {
  return [...HTML.matchAll(/data-state="([a-z]+)"/g)]
    .map((m) => m[1])
    .map((state) => (state === "track" ? "idle" : state));
}

function pageEndpointPaths(): string[] {
  const block = HTML.match(/<pre class="endpoints">([\s\S]*?)<\/pre>/);
  if (!block) throw new Error("landing-accuracy: endpoints block not found");
  return [...block[1].matchAll(/\/v1\/[A-Za-z0-9_:/.-]+/g)].map((m) => m[0]);
}

function serviceEndpointPaths(): string[] {
  // The OpenAPI operation table is the single canonical list of `/v1/*` routes.
  const operations = readFileSync(
    join(REPO_ROOT, "src/modules/service/openapi/operations.ts"),
    "utf-8",
  );
  return [...operations.matchAll(/path:\s*"(\/v1\/[^"]+)"/g)].map((m) => m[1]);
}

/** Route params have different names in code and docs (`:id` vs `{sessionId}`). */
const normalizeRoute = (route: string): string =>
  route.replace(/\/$/, "").replace(/[:{][A-Za-z]+}?/g, ":param");

/** GitHub-flavoured heading slug, so a `#anchor` can be checked for real. */
function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

describe("landing page accuracy", () => {
  it("does not advertise a removed feature", () => {
    const offenses: string[] = [];
    COPY.split(/\r?\n/).forEach((line, i) => {
      if (REMOVED_WORD_RE.test(line) || REMOVED_TOKENS.some((token) => line.includes(token))) {
        offenses.push(`line ${i + 1}: ${line.trim()}`);
      }
    });
    expect(offenses, `gh-pages still advertises a removed subsystem:\n${offenses.join("\n")}`).toEqual([]);
  });

  it("ships the same mascot states as the web UI", () => {
    const expected = faceStates();
    expect(expected.length).toBeGreaterThan(0);
    expect(new Set(pageStates())).toEqual(new Set(expected));
    expect(EN["mascot.count"]).toContain(`${expected.length} states`);
    expect(RU["mascot.count"]).toContain(`${expected.length} состояния`);
  });

  it("names only tools that exist in the registry", () => {
    const known = srcText();
    const named = (EN["tools.always.d"] ?? "")
      .split("·")
      .map((part) => part.split("—")[0].trim())
      .filter(Boolean);
    expect(named.length).toBeGreaterThan(3);
    const missing = named.filter((name) => !known.includes(`name: "${name}"`));
    expect(missing, `Landing page names tools that do not exist: ${missing.join(", ")}`).toEqual([]);
  }, 30000);

  it("lists only service routes that the server registers", () => {
    const registered = new Set(serviceEndpointPaths().map(normalizeRoute));
    const claimed = pageEndpointPaths().map(normalizeRoute);
    expect(claimed.length).toBeGreaterThan(3);
    const missing = claimed.filter((route) => !registered.has(route));
    expect(missing, `Landing page claims unregistered routes: ${missing.join(", ")}`).toEqual([]);
  });

  it("links only to documentation that exists in the repository", () => {
    const links = [...COPY.matchAll(/github\.com\/Alexeykoh\/micro-model-agent\/blob\/master\/([^"'\s)]+)/g)];
    expect(links.length).toBeGreaterThan(0);
    const missing: string[] = [];
    const badAnchor: string[] = [];
    for (const match of links) {
      // Якорь — часть URL, а не пути: `docs/install.md#manual` — это файл
      // `docs/install.md` + заголовок. Раньше проверка требовала файл с `#…`.
      const [path, anchor] = match[1].split("#");
      const file = join(REPO_ROOT, path);
      if (!existsSync(file)) {
        missing.push(match[1]);
        continue;
      }
      if (!anchor) continue;
      // Якорь обязан совпасть с id заголовка (GitHub slug) — иначе ссылка
      // «существует», но ведёт в пустоту.
      const text = readFileSync(file, "utf-8");
      const ids = new Set([
        ...[...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slugify(m[1])),
        ...[...text.matchAll(/<h[1-6][^>]*\sid="([^"]+)"/g)].map((m) => m[1]),
      ]);
      if (!ids.has(anchor)) badAnchor.push(`${path}#${anchor}`);
    }
    expect(missing, `Landing page links to missing files: ${missing.join(", ")}`).toEqual([]);
    expect(badAnchor, `Documentation anchors that resolve nowhere: ${badAnchor.join(", ")}`).toEqual([]);
  });

  it("has symmetric dictionaries and no orphan keys", () => {
    expect(Object.keys(EN).sort()).toEqual(Object.keys(RU).sort());
    const used = [...HTML.matchAll(/data-(?:i18n|i18n-html)="([^"]+)"/g)].map((m) => m[1]);
    const missing = [...new Set(used)].filter((key) => EN[key] === undefined);
    expect(missing, `Keys referenced by index.html but absent from i18n.js: ${missing.join(", ")}`).toEqual([]);
  });

  it("ships crawl and social metadata", () => {
    expect(HTML).toContain('property="og:image"');
    expect(HTML).toContain('name="twitter:image"');
    expect(HTML).toContain('name="robots"');
    expect(existsSync(join(PAGES, "robots.txt"))).toBe(true);
    expect(existsSync(join(PAGES, "sitemap.xml"))).toBe(true);
    expect(existsSync(join(PAGES, "og.png"))).toBe(true);
  });

  it("keeps the English copy readable without JavaScript", () => {
    const empty = [...HTML.matchAll(/<([a-zA-Z][\w-]*)[^>]*\sdata-i18n="([^"]+)"[^>]*><\/\1>/g)];
    expect(empty.map((m) => m[2]), "data-i18n elements must carry an English fallback").toEqual([]);
    expect(HTML).not.toMatch(/a sixth of a 32K/i);
  });

  it("ships a docs page whose sidebar anchors resolve", () => {
    const docs = readFileSync(join(PAGES, "docs.html"), "utf8");
    const side = docs.match(/<aside class="side"[\s\S]*?<\/aside>/)?.[0] ?? "";
    const ids = new Set([...docs.matchAll(/<h2 id="([^"]+)"/g)].map((m) => m[1]));
    const hrefs = [...side.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(20);
    expect(hrefs.filter((id) => !ids.has(id))).toEqual([]);
    expect(docs).toContain('href="index.html"');
    expect(docs).toContain('id="docsVer"');
    expect(docs).not.toMatch(REMOVED_WORD_RE);
  });
});
