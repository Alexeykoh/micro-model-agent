import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "../../src/logger/app-logger";
import { OutputChannel } from "../../src/output/channel";
import { OutputBus, type OutputEvent } from "../../src/output";

/**
 * INV-13 guard: every output event names its source.
 *
 * Before this wave `OutputChannel.writeLine` emitted `source: ""` and `Logger`
 * used a bare prefix, so machine-readable sinks could not tell who spoke. The
 * canonical `Source` is now `mma | core | module:<name> | tool:<name>`; this
 * test fails the build if an empty source creeps back into `src/`.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_ROOT = join(REPO_ROOT, "src");
const FILE_RE = /\.(ts|tsx)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);
const EMPTY_SOURCE_RE = /source:\s*(""|'')/;
const SOURCE_RE = /^(mma|core|module:.+|tool:.+)$/;

export interface ScanFile {
  path: string;
  text: string;
}

/** Returns `path:line: <source line>` for every empty `source` literal. */
export function findEmptySources(files: ScanFile[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (EMPTY_SOURCE_RE.test(lines[i])) offenders.push(`${file.path}:${i + 1}: ${lines[i].trim()}`);
    }
  }
  return offenders;
}

function walk(dir: string, files: ScanFile[]): void {
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

describe("output events name their source (INV-13)", () => {
  it("src never emits an empty source", () => {
    const files: ScanFile[] = [];
    walk(SCAN_ROOT, files);
    const offenders = findEmptySources(files);
    expect(offenders, `Empty source in output events:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("Logger tags named loggers as module:<name>, the root as mma", () => {
    const bus = new OutputBus();
    const events: OutputEvent[] = [];
    bus.subscribe((ev) => events.push(ev));

    new Logger("info", "indexer", bus).warn("named");
    new Logger("info", "", bus).warn("root");

    expect(events.map((e) => e.source)).toEqual(["module:indexer", "mma"]);
    for (const ev of events) expect(ev.source).toMatch(SOURCE_RE);
  });

  it("OutputChannel.writeLine tags host blocks as mma", () => {
    const bus = new OutputBus();
    const events: OutputEvent[] = [];
    bus.subscribe((ev) => events.push(ev));

    new OutputChannel(bus, { color: false }).writeLine("hello");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "block", source: "mma" });
  });
});
