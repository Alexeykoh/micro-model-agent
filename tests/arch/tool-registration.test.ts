import { describe, it, expect } from "vitest";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectFiles, findToolRegistryWrites, type ScanFile } from "../helpers/import-graph";

/**
 * Architecture gate A (INV-2, W1.5): tools enter the system through exactly one
 * writer — `registerOwnedTools`/`upsertOwnedTool` in `src/core/module-host.ts`.
 *
 * Every other path (core catalogue, module contributions, runner registries,
 * interactive `question`/`approve`, plugin sync) funnels through it. The guard
 * is strict: no allowlist, one designated writer file. Any new direct
 * `ToolRegistry.register`/`upsert` call outside it fails the build — so the
 * "tools come from one place" contract cannot silently rot.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SRC_ROOT = join(REPO_ROOT, "src");

/** The one file allowed to touch `ToolRegistry.register`/`upsert` (INV-2). */
const WRITER_FILE = "src/core/module-host.ts";

describe("architecture: single tool-registration path (INV-2)", () => {
  it("no ToolRegistry.register/upsert call exists outside the writer", () => {
    const files = collectFiles(SRC_ROOT, REPO_ROOT, [".ts"]);
    const offenders = findToolRegistryWrites(files)
      .filter((w) => w.path !== WRITER_FILE)
      .map((w) => `${w.path}:${w.line}: ${w.receiver}.${w.method}(...)`);
    expect(
      offenders,
      `Tool registered outside ${WRITER_FILE} (INV-2). Route it through ` +
        `registerOwnedTools/upsertOwnedTool:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("flags a direct registry write on a ToolRegistry-typed value", () => {
    const files: ScanFile[] = [
      {
        path: "src/core/bootstrap/x.ts",
        text: 'const registry = new ToolRegistry();\nregistry.register(tool, "core");\n',
      },
    ];
    expect(findToolRegistryWrites(files)).toEqual([
      { path: "src/core/bootstrap/x.ts", line: 2, method: "register", receiver: "registry" },
    ]);
  });

  it("flags a write reached through a toolRegistry property", () => {
    const files: ScanFile[] = [
      { path: "src/modules/foo/prompt-io.ts", text: "runner.toolRegistry.upsert(t, owner);\n" },
    ];
    expect(findToolRegistryWrites(files)).toEqual([
      {
        path: "src/modules/foo/prompt-io.ts",
        line: 1,
        method: "upsert",
        receiver: "runner.toolRegistry",
      },
    ]);
  });

  it("ignores unrelated registries", () => {
    const files: ScanFile[] = [
      {
        path: "src/core/bootstrap/modules-phase.ts",
        text:
          "moduleRegistry.register(execModule);\n" +
          "pluginManager.register(plugin);\n" +
          "const registry = new MCPRegistry();\n" +
          "registry.register(server);\n",
      },
    ];
    expect(findToolRegistryWrites(files)).toEqual([]);
  });

  it("ignores mentions in comments and strings", () => {
    const files: ScanFile[] = [
      {
        path: "src/core/bootstrap/x.ts",
        text: '// registry.register(tool, "core")\nconst s = "registry.register(t)";\n',
      },
    ];
    expect(findToolRegistryWrites(files)).toEqual([]);
  });
});
