// W3 плагина `angular11`: проверка идиом при записи (onAfterTool).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { ToolCall, ToolResult } from "../src/tools/types";
import { checkContent } from "../src/modules/plugins/builtin/angular11/rules";
import { runWriteCheck } from "../src/modules/plugins/builtin/angular11/write-check";

const made: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-ng11-wc-"));
  made.push(dir);
  return dir;
}
function angularWorkspace(rel: string, content: string): string {
  const dir = tmp();
  writeFileSync(join(dir, "angular.json"), "{}", "utf-8");
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf-8");
  return dir;
}
function call(name: string, path: string): ToolCall {
  return { id: "1", name, arguments: { path } };
}
function ok(output = "Written"): ToolResult {
  return { success: true, output };
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("angular11 rules — modern API is flagged", () => {
  it("flags standalone and takeUntilDestroyed", () => {
    const a = checkContent(".ts", `@Component({ selector: 'x', standalone: true })\nexport class X {}`);
    expect(a.some((f) => /standalone/.test(f.message))).toBe(true);
    const b = checkContent(".ts", `src$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe();`);
    expect(b.some((f) => /takeUntilDestroyed/.test(f.message))).toBe(true);
  });

  it("flags modern @angular/core imports and functional providers", () => {
    const a = checkContent(".ts", `import { signal, Component } from '@angular/core';`);
    expect(a.some((f) => /14\+\/17\+ API|signal/.test(f.message))).toBe(true);
    const b = checkContent(".ts", `bootstrapApplication(App, { providers: [provideRouter(routes)] });`);
    expect(b.some((f) => /provideRouter/.test(f.message))).toBe(true);
  });

  it("flags the @if/@for control flow syntax in templates", () => {
    const a = checkContent(".html", `<div>@if (visible) { <span>hi</span> }</div>`);
    expect(a.some((f) => /control flow is 17\+/.test(f.message))).toBe(true);
  });

  it("warns about a component subscription without ngOnDestroy", () => {
    const content = `@Component({ selector: 'x', template: '' })\nexport class X {\n  go() { this.svc.data().subscribe((d) => this.d = d); }\n}`;
    const a = checkContent(".ts", content);
    expect(a.some((f) => f.severity === "warn" && /subscription leak/.test(f.message))).toBe(true);
  });

  it("stays silent on idiomatic Angular 11 code", () => {
    const component = `@Component({ selector: 'x', templateUrl: './x.component.html' })\nexport class X implements OnInit, OnDestroy {\n  private sub = new Subscription();\n  ngOnDestroy() { this.sub.unsubscribe(); }\n  ngOnInit() { this.sub.add(this.svc.data().subscribe()); }\n}`;
    expect(checkContent(".ts", component)).toEqual([]);
    expect(checkContent(".html", `<div *ngIf="visible"><span *ngFor="let i of items">{{ i | date }}</span></div>`)).toEqual([]);
  });

  // Регресс живой проверки (2026-10-17): типовой HTTP-паттерн `.pipe(first())`
  // завершает подписку сам — это не утечка.
  it("stays silent on self-completing subscriptions (first()/take(1))", () => {
    const first = `@Component({ selector: 'x', templateUrl: './x.component.html' })\nexport class X {\n  ngOnInit() { this.svc.getAll().pipe(first()).subscribe((d) => this.d = d); }\n}`;
    expect(checkContent(".ts", first)).toEqual([]);
    const take = `@Component({ selector: 'x', templateUrl: './x.component.html' })\nexport class X {\n  ngOnInit() { this.svc.getAll().pipe(take(1)).subscribe((d) => this.d = d); }\n}`;
    expect(checkContent(".ts", take)).toEqual([]);
  });

  it("still warns about a bare subscription without teardown", () => {
    const content = `@Component({ selector: 'x', templateUrl: './x.component.html' })\nexport class X {\n  ngOnInit() { this.svc.stream().subscribe((d) => this.d = d); }\n}`;
    expect(
      checkContent(".ts", content).some((f) => f.severity === "warn" && /subscription leak/.test(f.message)),
    ).toBe(true);
  });
});

describe("angular11 write-check — onAfterTool", () => {
  it("appends findings after writing a modern-API file in an Angular workspace", () => {
    const dir = angularWorkspace("src/app/x.component.ts", `@Component({ selector: 'x', standalone: true })\nexport class X {}`);
    const result = ok();
    runWriteCheck({ baseDir: dir }, call("write_file", "src/app/x.component.ts"), result);
    expect(result.output).toContain("[Angular 11 check]");
    expect(result.output).toMatch(/standalone/);
  });

  it("does nothing outside an Angular workspace", () => {
    const dir = tmp();
    const full = join(dir, "x.component.ts");
    writeFileSync(full, `@Component({ standalone: true }) export class X {}`, "utf-8");
    const result = ok();
    runWriteCheck({ baseDir: dir }, call("write_file", "x.component.ts"), result);
    expect(result.output).toBe("Written");
  });

  it("ignores non-Angular extensions and failed writes", () => {
    const dir = angularWorkspace("README.md", "standalone: true");
    const mdResult = ok();
    runWriteCheck({ baseDir: dir }, call("write_file", "README.md"), mdResult);
    expect(mdResult.output).toBe("Written");

    const tsResult = { success: false, output: "boom" } as ToolResult;
    runWriteCheck({ baseDir: dir }, call("write_file", "src/app/x.component.ts"), tsResult);
    expect(tsResult.output).toBe("boom");
  });

  it("ignores read-only tools", () => {
    const dir = angularWorkspace("src/app/x.component.ts", `@Component({ standalone: true }) export class X {}`);
    const result = ok();
    runWriteCheck({ baseDir: dir }, call("read_file", "src/app/x.component.ts"), result);
    expect(result.output).toBe("Written");
  });
});

// Матрица расширенных правил (2026-10-17): закрыты blind-spot'ы, выявленные
// оценочным стендом `scripts/angular11-eval.ts`. Таблично — чтобы новые
// возможности не «ломались обратно» молча.
describe("angular11 rules — extended modern-API matrix", () => {
  const mustCatchTs: Array<[string, string]> = [
    ["bootstrapApplication", `bootstrapApplication(App);`],
    ["DestroyRef import", `import { DestroyRef } from '@angular/core';`],
    ["toSignal import", `import { toSignal } from '@angular/core/rxjs-interop';`],
    ["afterNextRender", `afterNextRender(() => {});`],
    ["functional guard type", `export const guard: CanActivateFn = () => true;`],
    ["hostDirectives", `@Component({ hostDirectives: [T] }) export class C {}`],
    ["NgOptimizedImage", `import { NgOptimizedImage } from '@angular/common';`],
    ["provideAnimationsAsync", `provideAnimationsAsync();`],
  ];
  for (const [name, code] of mustCatchTs) {
    it(`flags ${name}`, () => {
      expect(checkContent(".ts", code).length).toBeGreaterThan(0);
    });
  }

  const mustCatchHtml: Array<[string, string]> = [
    ["@defer", `<div>@defer { <x-cmp /> }</div>`],
    ["@let", `<div>@let n = a; {{ n }}</div>`],
  ];
  for (const [name, code] of mustCatchHtml) {
    it(`flags ${name}`, () => {
      expect(checkContent(".html", code).length).toBeGreaterThan(0);
    });
  }

  // Ловушки на ложные срабатывания: то же слово, но НЕ modern-API.
  const mustStaySilent: Array<[string, string]> = [
    ["bootstrapModule (Angular 11 way)", `platformBrowserDynamic().bootstrapModule(AppModule);`],
    ["a method literally named resource", `export class A { r() { return this.http.resource('x'); } }`],
    ["the word DestroyRef inside a string", `export class X { d() { return 'DestroyRef is 16+'; } }`],
  ];
  for (const [name, code] of mustStaySilent) {
    it(`stays silent on ${name}`, () => {
      expect(checkContent(".ts", code)).toEqual([]);
    });
  }
});
