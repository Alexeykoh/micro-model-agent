// W2 плагина `angular11`: архитектурный анализ воркспейса (angular_check).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyzeWorkspace } from "../src/modules/plugins/builtin/angular11/analyze";
import {
  angularTools,
  formatAnalysis,
} from "../src/modules/plugins/builtin/angular11/tools";

const made: string[] = [];
function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-ng11-check-"));
  made.push(dir);
  writeFileSync(join(dir, "angular.json"), "{}", "utf-8");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ dependencies: { "@angular/core": "^11.2.0" } }),
    "utf-8",
  );
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ROOT_MODULE = `
import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { AppComponent } from './app.component';
@NgModule({ declarations: [AppComponent], imports: [BrowserModule], bootstrap: [AppComponent] })
export class AppModule {}
`;

describe("angular11 check — tool definition", () => {
  it("exposes a read-only, cacheable angular_check tool", () => {
    const tools = angularTools();
    expect(tools.map((t) => t.name)).toEqual(["angular_check", "angular_scaffold"]);
    const check = tools.find((t) => t.name === "angular_check");
    expect(check?.security.caps).toEqual([{ fs: "read" }]);
    expect(check?.cacheable).toBe(true);
  });
});

describe("angular11 check — analysis", () => {
  it("reports an undeclared component and an impure pipe", () => {
    const dir = workspace({
      "src/app/app.module.ts": ROOT_MODULE,
      "src/app/app.component.ts": "export class AppComponent {}",
      "src/feature/feature.module.ts": `
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FooComponent } from './foo.component';
import { BadPipe } from './bad.pipe';
@NgModule({ declarations: [FooComponent, BadPipe], imports: [CommonModule] })
export class FeatureModule {}
`,
      "src/feature/foo.component.ts": "export class FooComponent {}",
      "src/feature/bad.pipe.ts": `
import { Pipe } from '@angular/core';
@Pipe({ name: 'bad', pure: false })
export class BadPipe {}
`,
      "src/lone/lone.component.ts": `
import { Component } from '@angular/core';
@Component({ selector: 'app-lone', template: '' })
export class LoneComponent {}
`,
    });

    const a = analyzeWorkspace(dir);
    expect(a.major).toBe(11);
    expect(a.modules).toHaveLength(2);
    const messages = a.findings.map((f) => f.message).join("\n");
    expect(messages).toContain('component "LoneComponent"');
    expect(messages).toMatch(/is not declared/);
    expect(messages).toContain('"BadPipe" is impure');
    // AppComponent и FooComponent объявлены — про них находок нет.
    expect(messages).not.toContain("AppComponent");
    expect(messages).not.toContain("FooComponent");
  });

  it("warns when a feature module uses common directives without CommonModule", () => {
    const dir = workspace({
      "src/app/app.module.ts": ROOT_MODULE,
      "src/app/app.component.ts": "export class AppComponent {}",
      "src/feature/feature.module.ts": `
import { NgModule } from '@angular/core';
import { FooComponent } from './foo.component';
@NgModule({ declarations: [FooComponent], imports: [] })
export class FeatureModule {}
`,
      "src/feature/foo.component.ts": `
import { Component } from '@angular/core';
@Component({ selector: 'app-foo', templateUrl: './foo.component.html' })
export class FooComponent {}
`,
      "src/feature/foo.component.html": `<div *ngIf="x">hello</div>`,
    });

    const a = analyzeWorkspace(dir);
    const messages = a.findings.map((f) => f.message).join("\n");
    expect(messages).toMatch(/does not import CommonModule/);
  });

  it("errors on BrowserModule in a feature module", () => {
    const dir = workspace({
      "src/app/app.module.ts": ROOT_MODULE,
      "src/app/app.component.ts": "export class AppComponent {}",
      "src/feature/feature.module.ts": `
import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { FooComponent } from './foo.component';
@NgModule({ declarations: [FooComponent], imports: [BrowserModule] })
export class FeatureModule {}
`,
      "src/feature/foo.component.ts": "export class FooComponent {}",
    });

    const a = analyzeWorkspace(dir);
    const errors = a.findings.filter((f) => f.severity === "error").map((f) => f.message);
    expect(errors.join("\n")).toMatch(/BrowserModule is imported by feature module/);
  });

  it("formats a readable, bounded summary", () => {
    const dir = workspace({
      "src/app/app.module.ts": ROOT_MODULE,
      "src/app/app.component.ts": "export class AppComponent {}",
    });
    const text = formatAnalysis(analyzeWorkspace(dir));
    expect(text).toContain("Angular check");
    expect(text).toContain("@angular/core: v11");
    expect(text).toContain("No structural issues found.");
  });

  it("warns about a non-11 major version", () => {
    const dir = workspace({
      "src/app/app.module.ts": ROOT_MODULE,
      "src/app/app.component.ts": "export class AppComponent {}",
    });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { "@angular/core": "^15.0.0" } }),
      "utf-8",
    );
    const text = formatAnalysis(analyzeWorkspace(dir));
    expect(text).toMatch(/uses Angular 15/);
  });
});

// Регрессы живой проверки на реальном Angular 11 (2026-10-17): типовые паттерны
// не должны давать ложных находок.
describe("angular11 check — real-world false-positive guards", () => {
  it("does not warn when a feature module imports a shared module that re-exports CommonModule", () => {
    const dir = workspace({
      "src/app/app.module.ts": ROOT_MODULE,
      "src/app/app.component.ts": "export class AppComponent {}",
      "src/app/shared/shared.module.ts": `
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
@NgModule({ imports: [CommonModule], exports: [CommonModule] })
export class SharedModule {}
`,
      "src/feature/feature.module.ts": `
import { NgModule } from '@angular/core';
import { SharedModule } from '../shared/shared.module';
import { FooComponent } from './foo.component';
@NgModule({ declarations: [FooComponent], imports: [SharedModule] })
export class FeatureModule {}
`,
      "src/feature/foo.component.ts": `
import { Component } from '@angular/core';
@Component({ selector: 'app-foo', templateUrl: './foo.component.html' })
export class FooComponent {}
`,
      "src/feature/foo.component.html": `<div *ngIf="x">hello</div>`,
    });

    const messages = analyzeWorkspace(dir).findings.map((f) => f.message).join("\n");
    expect(messages).not.toMatch(/does not import CommonModule/);
  });

  it("does not flag declarations given as an unresolvable barrel variable", () => {
    const dir = workspace({
      "src/app/app.module.ts": `
import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
@NgModule({ declarations: SHARED_COMPONENTS, imports: [BrowserModule] })
export class AppModule {}
`,
      "src/lone/lone.component.ts": `
import { Component } from '@angular/core';
@Component({ selector: 'app-lone', template: '' })
export class LoneComponent {}
`,
    });

    const messages = analyzeWorkspace(dir).findings.map((f) => f.message).join("\n");
    expect(messages).not.toMatch(/LoneComponent/);
  });

  it("resolves an inline barrel `const X = [...]` and flags a genuinely undeclared class", () => {
    const dir = workspace({
      "src/app/app.module.ts": `
import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
const COMPONENTS = [];
@NgModule({ declarations: COMPONENTS, imports: [BrowserModule] })
export class AppModule {}
`,
      "src/lone/lone.component.ts": `
import { Component } from '@angular/core';
@Component({ selector: 'app-lone', template: '' })
export class LoneComponent {}
`,
    });

    const messages = analyzeWorkspace(dir).findings.map((f) => f.message).join("\n");
    expect(messages).toMatch(/LoneComponent/);
  });
});
