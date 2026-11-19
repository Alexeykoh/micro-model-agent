// W1 плагина `angular11`: выключен по умолчанию, знание в промпте, детект воркспейса.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULTS } from "../src/config/defaults";
import { plugin as angular11Plugin } from "../src/modules/plugins/builtin/angular11";
import { ANGULAR11_KNOWLEDGE } from "../src/modules/plugins/builtin/angular11/knowledge";
import {
  isAngularProject,
  angularMajorVersion,
  findAngularRoot,
} from "../src/modules/plugins/builtin/angular11/detect";
import { PluginManager } from "../src/modules/plugins/manager";

const made: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-ng11-"));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("angular11 plugin — default disabled", () => {
  it("is in the default plugins deny-list", () => {
    expect(DEFAULTS.plugins?.disabled).toContain("angular11");
  });

  it("registers but stays inactive until enabled through the deny-list", () => {
    const pm = new PluginManager();
    pm.register(angular11Plugin);
    pm.setDisabledAll(DEFAULTS.plugins?.disabled ?? []);
    expect(pm.isEnabled("angular11")).toBe(false);
    pm.setDisabledAll([]);
    expect(pm.isEnabled("angular11")).toBe(true);
  });
});

describe("angular11 plugin — knowledge block", () => {
  it("returns a prescriptive Angular 11 block", () => {
    const block = angular11Plugin.onBuildPrompt?.();
    expect(block).toBe(ANGULAR11_KNOWLEDGE);
    expect(block).toContain("[ANGULAR 11]");
    // Ключевой стоп-сигнал эпохи: standalone НЕ существует.
    expect(block).toMatch(/standalone/i);
  });
});

describe("angular11 plugin — workspace detection", () => {
  it("finds an Angular root by the angular.json marker", () => {
    const root = tmp();
    writeFileSync(join(root, "angular.json"), "{}", "utf-8");
    const nested = join(root, "src", "app", "feature");
    mkdirSync(nested, { recursive: true });
    expect(findAngularRoot(nested)).toBe(root);
    expect(isAngularProject(nested)).toBe(true);
  });

  it("reports a non-Angular directory", () => {
    const dir = tmp();
    expect(isAngularProject(dir)).toBe(false);
  });

  it("reads the @angular/core major version", () => {
    const root = tmp();
    writeFileSync(join(root, "angular.json"), "{}", "utf-8");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "@angular/core": "^11.2.0" } }),
      "utf-8",
    );
    expect(angularMajorVersion(root)).toBe(11);
  });

  it("reads the version from devDependencies and tolerates a missing one", () => {
    const root = tmp();
    writeFileSync(join(root, "angular.json"), "{}", "utf-8");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { "@angular/core": "~11.0.5" } }),
      "utf-8",
    );
    expect(angularMajorVersion(root)).toBe(11);

    const noPkg = tmp();
    writeFileSync(join(noPkg, "angular.json"), "{}", "utf-8");
    expect(angularMajorVersion(noPkg)).toBeNull();
  });
});
