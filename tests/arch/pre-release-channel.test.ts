import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Pre-release channel gate.
 *
 * The docs link is a raw URL into the `pre` branch, so a stale tag in the
 * wrapper installs an old build while the page keeps promising the new one.
 * This gate pins the tag to package.json and checks the whole chain:
 * wrapper -> installer -> release workflow -> docs.
 */

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const pkg = JSON.parse(read("package.json")) as { version: string };
const PRE_TAG = `v${pkg.version}-pre.1`;

const SH = read("scripts/install-pre.sh");
const PS1 = read("scripts/install-pre.ps1");
const DOCS = read("gh-pages/docs.html");
const WORKFLOW = read(".github/workflows/release.yml");

describe("pre-release channel", () => {
  it("pins both wrappers to the current pre tag", () => {
    expect(SH, "install-pre.sh must pin the current pre tag").toContain(PRE_TAG);
    expect(PS1, "install-pre.ps1 must pin the current pre tag").toContain(PRE_TAG);
    expect(SH).toContain("MMA_INSTALL_BASE");
    expect(PS1).toContain("MMA_INSTALL_BASE");
  });

  it("delegates to the existing installers instead of copying them", () => {
    expect(SH).toMatch(/(^|\/)install\.sh/m);
    expect(PS1).toMatch(/(?:^|\/)install\.ps1/m);
    // The wrappers must not reimplement download/sha256 logic.
    expect(SH).not.toContain("fetch_verified");
    expect(PS1).not.toContain("Get-Artifact");
  });

  it("keeps the PowerShell wrapper ASCII-only (PS 5.1 reads it as ANSI)", () => {
    const nonAscii = [...PS1].filter((ch) => ch.charCodeAt(0) > 127);
    expect(nonAscii, `non-ASCII bytes in install-pre.ps1: ${nonAscii.join("")}`).toEqual([]);
  });

  it("publishes pre tags as GitHub Pre-Releases", () => {
    expect(WORKFLOW).toContain("prerelease: ${{ contains(github.ref_name, '-pre') }}");
  });

  it("links the pre installer from the bottom of the docs", () => {
    expect(DOCS).toContain('<h2 id="pre-release">');
    expect(DOCS).toContain('href="#pre-release"');
    expect(DOCS).toContain(
      "https://raw.githubusercontent.com/Alexeykoh/micro-model-agent/pre/scripts/install-pre.sh",
    );
    expect(DOCS).toContain(
      "https://raw.githubusercontent.com/Alexeykoh/micro-model-agent/pre/scripts/install-pre.ps1",
    );
    expect(DOCS).toContain(PRE_TAG);
    // The section must be the last one, not buried in the middle.
    const lastHeading = DOCS.lastIndexOf("<h2 ");
    expect(DOCS.slice(lastHeading)).toContain('id="pre-release"');
  });
});
