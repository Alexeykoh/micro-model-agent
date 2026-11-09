import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { LspModule } from "../../src/modules/lsp/module";
import { MCPModule } from "../../src/modules/mcp/module";
import { BrowserModule } from "../../src/modules/browser/module";
import { IndexerModule } from "../../src/modules/indexer/module";
import { SkillsModule } from "../../src/modules/skills/module";
import { MemoryModule } from "../../src/modules/memory/module";
import type { AppConfig } from "../../src/config/types";

describe("health() шести подсистем (INV-6: отказ ≠ отсутствие)", () => {
  it("lsp: ok при отсутствии заблокированных серверов", () => {
    const lsp = new LspModule({ enabled: true } as never);
    expect(lsp.health().status).toBe("ok");
  });

  it("mcp: ok без упавших серверов", () => {
    const mcp = new MCPModule({ mcpServers: {} } as AppConfig);
    expect(mcp.health().status).toBe("ok");
  });

  it("browser: degraded до пробы", () => {
    const browser = new BrowserModule();
    const h = browser.health();
    expect(h.status).toBe("degraded");
    expect(h.reason).toContain("not probed");
  });

  it("indexer: ok до первой стройки", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-idx-"));
    const idx = new IndexerModule({ baseDir: dir, cacheDir: join(dir, ".mma") });
    expect(idx.health().status).toBe("ok");
  });

  it("skills: ok без ошибок пересканирования (ноль скиллов — не failure)", () => {
    const skills = new SkillsModule([], 1000);
    expect(skills.health().status).toBe("ok");
    expect(() => skills.reload(() => { throw new Error("boom"); })).toThrow("boom");
    const h = skills.health();
    expect(h.status).toBe("degraded");
    expect(h.reason).toContain("boom");
  });

  it("memory: ok на читаемом сторе", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-mem-"));
    mkdirSync(join(dir, "memory"), { recursive: true });
    const mem = new MemoryModule(join(dir, "memory"));
    expect(mem.health().status).toBe("ok");
  });
});
