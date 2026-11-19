/**
 * Injects the agent version (`package.json`) into the static landing page.
 *
 * The site in `gh-pages/` is published as-is, with no build step, so the version
 * is baked into `index.html` and drifts from the agent on every release. This
 * step (run by `.github/workflows/pages.yml` before the upload) rewrites every
 * place the version is shown — `window.MMA_VERSION`, the `verChip` fallback and
 * the JSON-LD `softwareVersion` — from the single source of truth. Idempotent.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = join(root, "gh-pages", "index.html");
const docsPath = join(root, "gh-pages", "docs.html");

/** Replaces the first match of `re` with `value`, or throws if it is missing. */
function replaceOnce(src: string, re: RegExp, value: string, label: string): string {
  if (!re.test(src)) throw new Error(`sync-landing-version: no match for ${label}`);
  return src.replace(re, value);
}

async function main(): Promise<void> {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    version: string;
  };
  const { version } = pkg;
  const before = await readFile(indexPath, "utf8");

  let html = before;
  html = replaceOnce(
    html,
    /window\.MMA_VERSION = "[^"]*"/,
    `window.MMA_VERSION = "${version}"`,
    "window.MMA_VERSION",
  );
  html = replaceOnce(html, /(<span id="verChip">)v[^<]*(<\/span>)/, `$1v${version}$2`, "verChip");
  html = replaceOnce(
    html,
    /("softwareVersion"\s*:\s*)"[^"]*"/,
    `$1"${version}"`,
    "softwareVersion",
  );

  const docsBefore = await readFile(docsPath, "utf8").catch(() => null);
  if (docsBefore !== null) {
    const docs = replaceOnce(
      docsBefore,
      /(<span id="docsVer">)v[^<]*(<\/span>)/,
      `$1v${version}$2`,
      "docsVer",
    );
    if (docs !== docsBefore) {
      await writeFile(docsPath, docs);
      process.stdout.write(`[docs] injected version ${version} into gh-pages/docs.html\n`);
    }
  }

  if (html === before) {
    process.stdout.write(`[landing] version already ${version}\n`);
    return;
  }
  await writeFile(indexPath, html);
  process.stdout.write(`[landing] injected version ${version} into gh-pages/index.html\n`);
}

await main();
