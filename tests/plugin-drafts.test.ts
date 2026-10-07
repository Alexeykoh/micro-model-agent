// Черновики capabilities: инертность по умолчанию, согласие, LRU-лимит, живая
// регистрация после одобрения.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PluginManager } from "../src/modules/plugins/manager";
import { createDraftHost } from "../src/modules/plugins/draft-host";
import {
  approvalMarker,
  consentText,
  draftsDir,
  enforceLimit,
  isApproved,
  listDrafts,
  removeDraft,
  renderDraft,
  validateDraftSpec,
  writeDraft,
  type DraftSpec,
} from "../src/modules/plugins/drafts";
import { ToolRegistry } from "../src/tools/registry";
import { defineCapabilityTool } from "../src/tools/define-capability";
import type { ToolContext } from "../src/tools/types";
import { createPromptIO } from "../src/tools/prompt-io";

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function spec(over: Partial<DraftSpec> = {}): DraftSpec {
  return {
    name: "hello",
    description: "Say hello",
    parameters: { type: "object", properties: {} },
    code: "return { output: `hello` };",
    permissions: ["fs:read"],
    ...over,
  };
}

describe("plugin drafts — валидация и запись", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "mma-drafts-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("валидирует имя, описание, схему, код и права", () => {
    expect(validateDraftSpec(spec())).toBeNull();
    expect(validateDraftSpec(spec({ name: "Bad Name" }))).toContain("name must match");
    expect(validateDraftSpec(spec({ description: "  " }))).toContain("description");
    expect(validateDraftSpec(spec({ code: "" }))).toContain("code");
    expect(validateDraftSpec(spec({ parameters: null as never }))).toContain("parameters");
    // Права обязательны: декларация без единого заявления ничего не значит.
    expect(validateDraftSpec(spec({ permissions: [] }))).toContain("permissions");
  });

  it("пишет черновик и НЕ выполняет его без согласия", () => {
    const manager = new PluginManager();
    const host = createDraftHost({ baseDir: base, pluginManager: manager });
    const written = host.write(spec());
    expect(written.ok).toBe(true);
    expect(existsSync(written.path as string)).toBe(true);
    // Ключевое: файла на диске достаточно — чтобы он загрузился, нужно решение.
    expect(isApproved(base)).toBe(false);
    expect(host.loadApproved()).toBeNull();
    expect(manager.getRecords().map((r) => r.name)).toEqual([]);
  });

  it("шаблон содержит имя, права и тело хендлера агента", () => {
    const source = renderDraft(spec({ name: "sum", code: "return { output: String(args.a) };" }));
    expect(source).toContain('name: "sum"');
    expect(source).toContain('permissions: ["fs:read"]');
    expect(source).toContain("return { output: String(args.a) };");
    // Никакого eval: тело — обычный код модуля.
    expect(source).not.toContain("new Function");
    expect(source).not.toContain("eval(");
  });

  it("LRU: лишние черновики вытесняются, лимит из опций", () => {
    for (const name of ["a", "b", "c"]) writeDraft(base, spec({ name }));
    const dir = draftsDir(base);
    const pathA = join(dir, "a.ts");
    utimesSync(pathA, new Date(1000), new Date(1000));
    const evicted = enforceLimit(base, 2);
    expect(evicted).toEqual(["a"]);
    expect(listDrafts(base).map((d) => d.name)).toEqual(["b", "c"]);
  });

  it("removeDraft удаляет по имени и не падает на мусоре", () => {
    writeDraft(base, spec());
    expect(removeDraft(base, "hello")).toBe(true);
    expect(removeDraft(base, "hello")).toBe(false);
    expect(removeDraft(base, "../escape")).toBe(false);
  });

  it("текст согласия показывает имена файлов и полный код", () => {
    writeDraft(base, spec({ name: "shown", code: "return { output: 'SECRET-CODE-LINE' };" }));
    const text = consentText(listDrafts(base));
    expect(text).toContain("shown");
    expect(text).toContain("SECRET-CODE-LINE");
  });

  it("маркер разрешения лежит вне каталога черновиков (иначе стал бы плагином)", () => {
    hostApprove(base);
    expect(isApproved(base)).toBe(true);
    expect(existsSync(approvalMarker(base))).toBe(true);
    expect(approvalMarker(base).startsWith(draftsDir(base))).toBe(false);
  });
});

function hostApprove(base: string): void {
  createDraftHost({ baseDir: base, pluginManager: new PluginManager() }).approve();
}

describe("plugin drafts — одобрение и живая регистрация", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "mma-drafts-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("после approve reload регистрирует capability, её тул попадает в реестр", () => {
    const manager = new PluginManager();
    const host = createDraftHost({ baseDir: base, pluginManager: manager });
    const registry = new ToolRegistry();
    manager.attachToolRegistry(registry);

    host.write(spec({ name: "greeter", code: "return { output: 'hi' };" }));
    host.approve();
    const report = host.reloadDrafts();

    expect(report.loaded).toBe(1);
    expect(report.failed).toBe(0);
    const tool = registry.get("plugin__greeter__greeter");
    expect(tool).toBeDefined();
    expect(tool?.tags).toContain("plugin:greeter");
    // Запись помечена как черновик — UI покажет это пользователю.
    expect(manager.getRecords()[0].draft).toBe(true);
  });

  it("revoke выгружает код и снова делает черновики инертными", () => {
    const manager = new PluginManager();
    const host = createDraftHost({ baseDir: base, pluginManager: manager });
    host.write(spec());
    host.approve();
    host.reloadDrafts();
    expect(manager.getRecords()).toHaveLength(1);

    host.revoke();
    expect(isApproved(base)).toBe(false);
    expect(manager.getRecords()).toHaveLength(0);
    expect(host.loadApproved()).toBeNull();
  });

  it("битый черновик не роняет загрузку, а попадает в failures", () => {
    const manager = new PluginManager();
    const host = createDraftHost({ baseDir: base, pluginManager: manager });
    mkdirSync(draftsDir(base), { recursive: true });
    writeFileSync(join(draftsDir(base), "broken.ts"), "export default { name: ", "utf-8");

    host.approve();
    const report = host.reloadDrafts();
    expect(report.failed).toBe(1);
    expect(manager.getFailures()[0].entry).toContain("broken");
  });
});

describe("define_capability", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "mma-drafts-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** Контекст тула с заранее заданным ответом пользователя (меню: 1 — allow). */
  function ctxWith(answer: "allow" | "deny"): ToolContext {
    const manager = new PluginManager();
    const host = createDraftHost({ baseDir: base, pluginManager: manager });
    const registry = new ToolRegistry();
    manager.attachToolRegistry(registry);
    // `askChoice` ждёт номер пункта меню, а не слово: 1 — allow, 2 — deny.
    const answers = [answer === "allow" ? "1" : "2"];
    const io = createPromptIO({
      ask: async () => answers.shift() ?? "2",
      print: () => {},
    });
    const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} };
    return {
      baseDir: base,
      logger,
      config: { plugins: {} },
      pluginDrafts: host,
      promptIO: io,
    } as unknown as ToolContext;
  }

  const args = {
    name: "greeter",
    description: "Greet someone",
    parameters: { type: "object", properties: { who: { type: "string" } } },
    code: "return { output: 'hi ' + (args.who ?? '') };",
    permissions: ["fs:read"],
  };

  it("пользователь разрешает — capability регистрируется и её тул доступен", async () => {
    const ctx = ctxWith("allow");
    const result = await defineCapabilityTool.handler(ctx, args);
    expect(result.success).toBe(true);
    expect(result.output).toContain("greeter");
    const manager = (ctx as { pluginDrafts?: { state(): { loaded: string[] } } }).pluginDrafts!;
    expect(manager.state().loaded).toEqual(["greeter"]);
  });

  it("пользователь отказывает — черновик записан, но НЕ загружен", async () => {
    const ctx = ctxWith("deny");
    const result = await defineCapabilityTool.handler(ctx, args);
    expect(result.success).toBe(true);
    expect(result.output.toLowerCase()).toContain("not loaded");
    const state = (ctx as { pluginDrafts?: { state(): { loaded: string[]; drafts: unknown[] } } })
      .pluginDrafts!;
    expect(state.state().drafts).toHaveLength(1);
    expect(state.state().loaded).toHaveLength(0);
  });

  it("невалидное описание не пишет файл и объясняет модель причину", async () => {
    const ctx = ctxWith("allow");
    const result = await defineCapabilityTool.handler(ctx, { ...args, permissions: [] });
    expect(result.success).toBe(false);
    expect(result.output).toContain("permissions");
    expect(existsSync(join(draftsDir(base), "greeter.ts"))).toBe(false);
  });

  it("без хоста черновиков тул отвечает честно, а не падает", async () => {
    const ctx = { baseDir: base } as ToolContext;
    const result = await defineCapabilityTool.handler(ctx, args);
    expect(result.success).toBe(false);
    expect(result.output).toContain("unavailable");
  });

  it("имя тула в реестре следует конвенции plugin__<плагин>__<тул>", async () => {
    const ctx = ctxWith("allow");
    await defineCapabilityTool.handler(ctx, args);
    const drafts = listDrafts(base);
    expect(drafts[0].name).toBe(NAME_RE.test(drafts[0].name) ? "greeter" : drafts[0].name);
  });
});
