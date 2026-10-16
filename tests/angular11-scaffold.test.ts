// W4 плагина `angular11`: генерация каркаса (angular_scaffold).
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ToolContext } from "../src/tools/types";
import { normaliseName, scaffoldFiles } from "../src/modules/plugins/builtin/angular11/scaffold";
import { angularTools } from "../src/modules/plugins/builtin/angular11/tools";

const made: string[] = [];
function tmp(angular = true): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-ng11-scaffold-"));
  made.push(dir);
  if (angular) writeFileSync(join(dir, "angular.json"), "{}", "utf-8");
  return dir;
}
function ctx(dir: string): ToolContext {
  return { baseDir: dir } as unknown as ToolContext;
}
function scaffoldTool() {
  const tool = angularTools().find((t) => t.name === "angular_scaffold");
  if (!tool) throw new Error("angular_scaffold not found");
  return tool;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("angular11 scaffold — names", () => {
  it("normalises kebab and PascalCase, strips a service suffix", () => {
    expect(normaliseName("user-card")).toEqual({ base: "user-card", className: "UserCard" });
    expect(normaliseName("UserCard")).toEqual({ base: "user-card", className: "UserCard" });
    expect(normaliseName("user.service")).toEqual({ base: "user", className: "User" });
    expect(normaliseName("   ")).toBeNull();
  });
});

describe("angular11 scaffold — generated content", () => {
  it("emits classic NgModule-era boilerplate without modern APIs", () => {
    const component = scaffoldFiles("component", { base: "user-card", className: "UserCard" });
    const ts = component["user-card.component.ts"];
    expect(ts).toContain("templateUrl: './user-card.component.html'");
    expect(ts).toContain("export class UserCardComponent");
    expect(ts).not.toMatch(/standalone|takeUntilDestroyed|provideRouter|signal\(/);
    expect(component["user-card.component.html"]).toBeTruthy();

    const guard = scaffoldFiles("guard", { base: "auth", className: "Auth" })["auth.guard.ts"];
    expect(guard).toContain("implements CanActivate");
    expect(guard).not.toMatch(/standalone/);

    const mod = scaffoldFiles("module", { base: "shop", className: "Shop" })["shop.module.ts"];
    expect(mod).toContain("imports: [CommonModule]");
  });
});

describe("angular11 scaffold — tool handler", () => {
  it("writes files and reminds about NgModule declarations", async () => {
    const dir = tmp();
    const res = await scaffoldTool().handler(ctx(dir), {
      kind: "component",
      name: "user-card",
      path: "src/app",
    });
    expect(res.success).toBe(true);
    expect(existsSync(join(dir, "src/app/user-card.component.ts"))).toBe(true);
    expect(res.output).toMatch(/declare UserCardComponent/);
    const written = readFileSync(join(dir, "src/app/user-card.component.ts"), "utf-8");
    expect(written).not.toMatch(/standalone/);
  });

  it("refuses to overwrite unless force is set", async () => {
    const dir = tmp();
    const tool = scaffoldTool();
    await tool.handler(ctx(dir), { kind: "service", name: "auth", path: "src/app" });
    const again = await tool.handler(ctx(dir), { kind: "service", name: "auth", path: "src/app" });
    expect(again.success).toBe(false);
    expect(again.output).toMatch(/refusing to overwrite/);

    const forced = await tool.handler(ctx(dir), {
      kind: "service",
      name: "auth",
      path: "src/app",
      force: true,
    });
    expect(forced.success).toBe(true);
  });

  it("refuses outside an Angular workspace and on a bad kind", async () => {
    const outside = tmp(false);
    const res = await scaffoldTool().handler(ctx(outside), { kind: "pipe", name: "x" });
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/not inside an Angular workspace/);

    const dir = tmp();
    const bad = await scaffoldTool().handler(ctx(dir), { kind: "widget", name: "x" });
    expect(bad.success).toBe(false);
    expect(bad.output).toMatch(/unknown kind/);
  });

  it("declares fs:write with the path arg for enforcement", () => {
    const tool = scaffoldTool();
    expect(tool.security.caps).toEqual([{ fs: "write" }]);
    expect(tool.security.pathArgs).toEqual(["path"]);
  });
});
