import { describe, it, expect } from "vitest";
import { extractChangelogRange, extractLatestChangelog } from "../src/modules/updater/changelog-reader";

const SAMPLE_CHANGELOG = `# Changelog

All notable changes will be documented.

## [0.56.1] - 2026-08-27

### Added
- **Docs**: CHANGELOG.md included in npm package

## [0.56.0] - 2026-08-27

### Added
- **MoE**: live re-plan loop
- **LSP**: Angular support

### Fixed
- **Security**: SSRF fix

## [0.55.1] - 2026-08-25

### Fixed
- **LLM**: NDJSON parser fix

## [0.55.0] - 2026-08-25

### Added
- **Certification**: targeted re-run
`;

describe("extractLatestChangelog", () => {
  it("extracts the most recent version entry", () => {
    const result = extractLatestChangelog(SAMPLE_CHANGELOG);
    expect(result).toContain("## [0.56.1]");
    expect(result).toContain("CHANGELOG.md included");
    expect(result).not.toContain("## [0.56.0]");
  });

  it("returns null for empty changelog", () => {
    expect(extractLatestChangelog("")).toBeNull();
  });

  it("returns null when no version sections found", () => {
    expect(extractLatestChangelog("# Changelog\n\nSome text here.")).toBeNull();
  });

  it("handles single version entry", () => {
    const single = "## [1.0.0] - 2026-01-01\n\n### Added\n- Feature";
    const result = extractLatestChangelog(single);
    expect(result).toContain("## [1.0.0]");
    expect(result).toContain("Feature");
  });
});

describe("extractChangelogRange", () => {
  it("extracts versions between from and to (exclusive from, inclusive to)", () => {
    const result = extractChangelogRange(SAMPLE_CHANGELOG, "0.55.1", "0.56.1");
    expect(result).toContain("## [0.56.1]");
    expect(result).toContain("## [0.56.0]");
    expect(result).not.toContain("## [0.55.1]");
    expect(result).not.toContain("## [0.55.0]");
  });

  it("returns null when no versions in range", () => {
    const result = extractChangelogRange(SAMPLE_CHANGELOG, "0.56.1", "0.56.1");
    expect(result).toBeNull();
  });

  it("returns null for non-existent version", () => {
    const result = extractChangelogRange(SAMPLE_CHANGELOG, "99.0.0", "99.0.0");
    expect(result).toBeNull();
  });

  it("extracts single version when from is previous version", () => {
    const result = extractChangelogRange(SAMPLE_CHANGELOG, "0.56.0", "0.56.1");
    expect(result).toContain("## [0.56.1]");
    expect(result).not.toContain("## [0.56.0]");
  });

  it("handles empty changelog", () => {
    expect(extractChangelogRange("", "0.55.0", "0.56.0")).toBeNull();
  });

  it("returns null when from version is not in changelog", () => {
    const result = extractChangelogRange(SAMPLE_CHANGELOG, "0.0.0", "0.56.1");
    expect(result).toBeNull();
  });
});
