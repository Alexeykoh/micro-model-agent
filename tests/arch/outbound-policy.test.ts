import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Architecture gate (W13): every outbound HTTP call in `src/` either goes
 * through the network policy or carries a justified allowlist entry.
 *
 * `fetchValidated`/`fetchOutbound` are the sanctioned paths. Anything else is a
 * raw `fetch(` and must explain itself — an entry without a reason is a build
 * failure, so the list cannot grow by accident.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SRC_ROOT = join(REPO_ROOT, "src");
const FILE_RE = /\.(ts|tsx)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);
/**
 * Исходящий вызов: глобальный `fetch(...)` или вызов через шов `fetchImpl(...)`.
 * `typeof fetch`, `fetchImpl?: typeof fetch` и `deps.fetchImpl` под объявление
 * не попадают — regex требует открывающей скобки сразу за именем.
 */
const FETCH_RE = /(?<![.\w?])(?:fetch|fetchImpl)\s*(?:<[^>]*>)?\s*\(/;
const POLICY_CALL_RE = /\b(fetchValidated|fetchOutbound|checkOutboundUrl)\s*\(/;

/**
 * Raw `fetch(` sites allowed without the policy, each with the reason it is not
 * a user/model-supplied destination. Trimmed reason → test failure.
 */
export const OUTBOUND_FETCH_ALLOWLIST: Record<string, string> = {
  "src/llm/openai-compat.ts": "provider endpoint from config (baseUrl + path)",
  "src/llm/provider-budget.ts": "same provider endpoint, budget probe",
  "src/llm/provider-context.ts": "ollama probe from config baseUrl",
  "src/llm/model-loader.ts": "ollama load endpoint from config baseUrl",
  "src/llm/models-dev.ts": "hardcoded models.dev registry URL",
  "src/llm/native-context.ts": "native context endpoint from provider config",
  "src/llm/image-utils.ts": "image URL already validated by the caller (attach-image)",
  "src/modules/providers/preflight.ts": "provider endpoint from config (baseUrl)",
  "src/modules/mcp/client.ts": "MCP server URL from user config; separate allowlist (mcp.allowedServers)",
  "src/modules/updater/checker.ts": "GitHub releases URL, hardcoded",
  "src/modules/updater/install-release.ts": "GitHub release asset URL from latest.json",
  "src/modules/setup/discovery.ts": "local setup probe: localhost ports and provider URLs from config",
  "src/tools/web-search.ts": "search API URL from config; ToolExecutor validates urlArgs (INV-10)",
  "src/modules/security/network-validator.ts": "the policy itself: fetchValidated revalidates every hop",
  "src/modules/webui/assets/js/api.ts": "same-origin relative path in the browser",
  "src/modules/webui/assets/js/sidebar/files/view.ts": "same-origin relative path in the browser",
  "src/modules/webui/assets/setup.ts": "same-origin relative path in the browser",
};

/** Возвращает `path:line` для каждого `fetch(` вне политики и вне allowlist. */
export function findUnvalidatedFetch(
  files: Array<{ path: string; text: string }>,
  allowlist: Readonly<Record<string, string>> = OUTBOUND_FETCH_ALLOWLIST,
): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    if (allowlist[file.path]) continue;
    const lines = file.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = line.trimStart();
      if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) continue;
      if (!FETCH_RE.test(line) || POLICY_CALL_RE.test(file.text)) continue;
      if (POLICY_CALL_RE.test(line)) continue;
      offenders.push(`${file.path}:${i + 1}: ${line.trim()}`);
    }
  }
  return offenders;
}

function walk(dir: string, files: Array<{ path: string; text: string }>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), files);
      continue;
    }
    if (!entry.isFile() || !FILE_RE.test(entry.name)) continue;
    const full = join(dir, entry.name);
    files.push({
      path: relative(REPO_ROOT, full).replace(/\\/g, "/"),
      text: readFileSync(full, "utf-8"),
    });
  }
}

function scanSrc(): Array<{ path: string; text: string }> {
  const files: Array<{ path: string; text: string }> = [];
  walk(SRC_ROOT, files);
  return files;
}

describe("architecture: outbound network policy (W13)", () => {
  it("every fetch( in src/ goes through the policy or a justified allowlist entry", () => {
    const offenders = findUnvalidatedFetch(scanSrc());
    expect(
      offenders,
      `Outbound HTTP call bypasses the network policy (SSRF, W13). Route it through ` +
        `fetchOutbound()/fetchValidated(), or add a justified entry (non-empty reason) to ` +
        `OUTBOUND_FETCH_ALLOWLIST in tests/arch/outbound-policy.test.ts:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("has no allowlist entry without a reason", () => {
    const unjustified = Object.entries(OUTBOUND_FETCH_ALLOWLIST)
      .filter(([, reason]) => reason.trim().length < 10)
      .map(([path]) => path);
    expect(
      unjustified,
      `Allowlist entries without a reason:\n${unjustified.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps only allowlist entries that still contain a fetch(", () => {
    const files = new Map(scanSrc().map((f) => [f.path, f.text]));
    const stale = Object.keys(OUTBOUND_FETCH_ALLOWLIST).filter(
      (path) => !FETCH_RE.test(files.get(path) ?? ""),
    );
    expect(stale, `Allowlist entries with no fetch() left to justify:\n${stale.join("\n")}`).toEqual([]);
  });

  it("scanner flags a raw fetch fixture", () => {
    const offenders = findUnvalidatedFetch([
      { path: "src/modules/foo/bar.ts", text: "const r = await fetch(opts.url);\n" },
    ]);
    expect(offenders).toEqual(["src/modules/foo/bar.ts:1: const r = await fetch(opts.url);"]);
  });

  it("scanner accepts a fixture routed through the policy", () => {
    const offenders = findUnvalidatedFetch([
      { path: "src/modules/foo/bar.ts", text: "const r = await fetchOutbound(opts.url, init, o);\n" },
    ]);
    expect(offenders).toEqual([]);
  });
});