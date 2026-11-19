// Валидация метаданных плагина и сборка плоской записи для UI/CLI.
import { describe, it, expect } from "vitest";
import {
  buildRecord,
  detectHooks,
  firstLine,
  PLUGIN_PERMISSIONS,
  sanitizePermissions,
  validatePluginMeta,
} from "../src/modules/plugins/records";
import type { AgentPlugin } from "../src/modules/types";

function plugin(extra: Partial<AgentPlugin> = {}): AgentPlugin {
  return { name: "my-plugin", ...extra };
}

describe("records.ts — validatePluginMeta", () => {
  it("accepts a bare 8-line plugin with no metadata at all", () => {
    const res = validatePluginMeta(plugin());
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it("rejects a nameless plugin as an error", () => {
    const res = validatePluginMeta({ name: "" } as AgentPlugin);
    expect(res.errors.length).toBe(1);
    expect(res.errors[0]).toContain("invalid name");
  });

  it("rejects uppercase and spaced names", () => {
    expect(validatePluginMeta(plugin({ name: "My Plugin" })).errors.length).toBe(1);
    expect(validatePluginMeta(plugin({ name: "UPPER" })).errors.length).toBe(1);
  });

  it("accepts dots, dashes and underscores in names", () => {
    expect(validatePluginMeta(plugin({ name: "my.plugin-2_x" })).errors).toEqual([]);
  });

  it("warns on a non-semver version but still registers", () => {
    const res = validatePluginMeta(plugin({ version: "not-a-version" }));
    expect(res.errors).toEqual([]);
    expect(res.warnings.some((w) => w.includes("version"))).toBe(true);
  });

  it("accepts a v-prefixed semver", () => {
    expect(validatePluginMeta(plugin({ version: "v1.2.3" })).warnings).toEqual([]);
  });

  it("warns on empty author and over-long description", () => {
    const res = validatePluginMeta(plugin({ author: "  ", description: "x".repeat(401) }));
    expect(res.warnings.some((w) => w.includes("author"))).toBe(true);
    expect(res.warnings.some((w) => w.includes("description"))).toBe(true);
  });

  it("warns on a non-http homepage", () => {
    const res = validatePluginMeta(plugin({ homepage: "javascript:alert(1)" }));
    expect(res.warnings.some((w) => w.includes("homepage"))).toBe(true);
  });

  it("accepts an http(s) homepage silently", () => {
    expect(validatePluginMeta(plugin({ homepage: "https://example.com/p" })).warnings).toEqual([]);
  });

  it("warns about unknown permissions", () => {
    const res = validatePluginMeta(
      plugin({ permissions: ["process", "root:all"] as never }),
    );
    expect(res.warnings.some((w) => w.includes("root:all"))).toBe(true);
  });
});

describe("records.ts — sanitizePermissions", () => {
  it("keeps canonical order regardless of input order", () => {
    const res = sanitizePermissions(["session:write", "config:read", "process"]);
    expect(res.permissions).toEqual(["config:read", "process", "session:write"]);
  });

  it("drops duplicates", () => {
    expect(sanitizePermissions(["fs:read", "fs:read"]).permissions).toEqual(["fs:read"]);
  });

  it("reports unknown values separately", () => {
    const res = sanitizePermissions(["fs:read", "nope", "also-nope"]);
    expect(res.permissions).toEqual(["fs:read"]);
    expect(res.unknown).toEqual(["nope", "also-nope"]);
  });

  it("tolerates non-array input", () => {
    expect(sanitizePermissions(undefined)).toEqual({ permissions: [], unknown: [] });
  });

  it("exposes the canonical list", () => {
    expect(PLUGIN_PERMISSIONS).toContain("process");
    expect(PLUGIN_PERMISSIONS).toHaveLength(6);
  });
});

describe("records.ts — detectHooks", () => {
  it("is empty for a plugin with no hooks", () => {
    expect(detectHooks(plugin())).toEqual([]);
  });

  it("lists implemented hooks in interface order", () => {
    const p = plugin({ onTurnEnd: () => {}, onToolEnd: () => {}, onText: () => undefined });
    expect(detectHooks(p)).toEqual(["onToolEnd", "onText", "onTurnEnd"]);
  });

  it("ignores non-function fields", () => {
    const p = plugin({ onText: "not a function" as never });
    expect(detectHooks(p)).toEqual([]);
  });
});

describe("records.ts — buildRecord", () => {
  it("carries every metadata field through", () => {
    const p = plugin({
      version: "1.2.3",
      author: "alexe",
      description: "does a thing",
      homepage: "https://example.com",
      source: "project",
      path: "/tmp/.mma/plugins/foo/plugin.ts",
      permissions: ["fs:read", "process"],
      provides: { tools: ["foo_run"] },
    });
    const record = buildRecord(p, { enabled: true, loadedAt: 123 });
    expect(record).toMatchObject({
      name: "my-plugin",
      version: "1.2.3",
      author: "alexe",
      description: "does a thing",
      homepage: "https://example.com",
      source: "project",
      builtin: false,
      enabled: true,
      path: "/tmp/.mma/plugins/foo/plugin.ts",
      loadedAt: 123,
    });
    expect(record.permissions).toEqual(["fs:read", "process"]);
    expect(record.provides.tools).toEqual(["foo_run"]);
    expect(record.error).toBeUndefined();
  });

  it("detects hooks when provides.hooks is absent", () => {
    const p = plugin({ onSessionStart: () => {} });
    expect(buildRecord(p, { enabled: true }).provides.hooks).toEqual(["onSessionStart"]);
  });

  it("prefers explicit provides.hooks", () => {
    const p = plugin({ onSessionStart: () => {}, provides: { hooks: ["custom"] } });
    expect(buildRecord(p, { enabled: true }).provides.hooks).toEqual(["custom"]);
  });

  it("flags builtins", () => {
    expect(buildRecord(plugin({ isBuiltin: true }), { enabled: true }).builtin).toBe(true);
  });

  it("marks a disabled plugin", () => {
    expect(buildRecord(plugin(), { enabled: false }).enabled).toBe(false);
  });

  it("drops invalid homepage/author instead of showing them raw", () => {
    const p = plugin({ homepage: "file:///etc/passwd", author: "x".repeat(200) });
    const record = buildRecord(p, { enabled: true });
    expect(record.homepage).toBeUndefined();
    expect(record.author).toBeUndefined();
    expect(record.warnings.length).toBeGreaterThan(0);
  });

  it("detects a draft plugin from the path (posix and windows separators)", () => {
    expect(buildRecord(plugin({ path: "/p/.mma/plugins/drafts/foo/plugin.ts" }), { enabled: true }).draft).toBe(true);
    expect(buildRecord(plugin({ path: "C:\\p\\.mma\\plugins\\drafts\\foo\\plugin.ts" }), { enabled: true }).draft).toBe(true);
    expect(buildRecord(plugin({ path: "/p/.mma/plugins/foo/plugin.ts" }), { enabled: true }).draft).toBe(false);
    expect(buildRecord(plugin(), { enabled: true }).draft).toBe(false);
  });

  it("carries a load error", () => {
    expect(buildRecord(plugin(), { enabled: false, error: "boom" }).error).toBe("boom");
  });
});

describe("records.ts — firstLine", () => {
  it("keeps only the first line", () => {
    expect(firstLine("a\nb\nc")).toBe("a");
  });

  it("truncates very long messages", () => {
    const out = firstLine("x".repeat(500));
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("…")).toBe(true);
  });

  it("handles empty input", () => {
    expect(firstLine("")).toBe("");
  });
});
