import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRegistry } from "../../src/modules/documents/registry";
import { csvHandler } from "../../src/modules/documents/handlers/csv";
import { documentMapTool } from "../../src/modules/documents/tools/document-map";
import { documentReadTool } from "../../src/modules/documents/tools/document-read";

const dir = mkdtempSync(join(tmpdir(), "doc-tool-"));
writeFileSync(join(dir, "a.csv"), "a,b\n1,2");
const reg = buildRegistry({ enabled: true, groups: ["text"], handlers: [csvHandler] });
const ctx = { baseDir: dir, logger: { debug() {}, info() {}, warn() {}, error() {} } } as never;

describe("doc tools", () => {
  it("document_map отдаёт карту", async () => {
    const res = await documentMapTool(reg).handler(ctx, { path: "a.csv" });
    expect(res.success).toBe(true);
    expect(res.output).toContain("format: csv");
  });
  it("плохой путь — fail-open с причиной", async () => {
    const res = await documentMapTool(reg).handler(ctx, { path: "nope.csv" });
    expect(res.success).toBe(false);
    expect(String(res.output)).toMatch(/no handler|ENOENT|нет/i);
  });
  it("тулы несут security.fs=read и pathArgs", () => {
    expect(documentMapTool(reg).security.caps).toContainEqual({ fs: "read" });
    expect(documentMapTool(reg).security.pathArgs).toContain("path");
    expect(documentReadTool(reg).security.pathArgs).toContain("path");
  });
});
