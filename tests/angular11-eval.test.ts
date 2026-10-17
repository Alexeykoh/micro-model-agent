// Оценочный корпус плагина `angular11` (2026-10-17): размеченные дефекты и
// заведомо чистые образцы, прогоняемые через обе поверхности — `checkContent`
// (write-check) и `analyzeWorkspace` (angular_check).
//
// Служит двум целям: (1) стенд — recall = «catch»-кейсы пойманы, FP-rate = 0
// на «clean»-кейсах; (2) регресс-гвард (правило 5): каждая новая возможность
// закреплена кейсом, чтобы её нельзя было сломать молча. Расширять корпус при
// каждом новом правиле.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyzeWorkspace } from "../src/modules/plugins/builtin/angular11/analyze";
import { checkContent } from "../src/modules/plugins/builtin/angular11/rules";

const made: string[] = [];
function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-ng11-eval-"));
  made.push(dir);
  writeFileSync(join(dir, "angular.json"), "{}");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ dependencies: { "@angular/core": "~11.0.4" } }),
  );
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Kind = "catch" | "clean";
interface WriteCase {
  id: string;
  kind: Kind;
  ext: ".ts" | ".html";
  content: string;
}
interface CheckCase {
  id: string;
  kind: Kind;
  files: Record<string, string>;
}

const APP_MODULE = `import { NgModule } from '@angular/core';\nimport { BrowserModule } from '@angular/platform-browser';\nimport { XComponent } from './x.component';\n@NgModule({ declarations: [XComponent], imports: [BrowserModule] })\nexport class AppModule {}\n`;
const COMPONENT = `import { Component } from '@angular/core';\n@Component({ selector: 'app-x', template: '' })\nexport class XComponent {}\n`;

// ---- write-check: .ts/.html ----
const writeCases: WriteCase[] = [
  // Современный API (14+/16+/17+/19+) — должно ловиться.
  { id: "standalone", kind: "catch", ext: ".ts", content: `@Component({ selector: 'x', template: '', standalone: true })\nexport class X {}\n` },
  { id: "takeUntilDestroyed", kind: "catch", ext: ".ts", content: `export class X { s = this.d$.pipe(takeUntilDestroyed()); }\n` },
  { id: "provideRouter", kind: "catch", ext: ".ts", content: `export const routes = provideRouter([]);\n` },
  { id: "provideHttpClient", kind: "catch", ext: ".ts", content: `export const c = provideHttpClient();\n` },
  { id: "provideAnimationsAsync", kind: "catch", ext: ".ts", content: `provideAnimationsAsync();\n` },
  { id: "viewChild", kind: "catch", ext: ".ts", content: `export class X { ref = viewChild('tpl'); }\n` },
  { id: "requiredInput", kind: "catch", ext: ".ts", content: `@Component({ selector: 'x', template: '' })\nexport class X { @Input({ required: true }) name!: string; }\n` },
  { id: "import-signal", kind: "catch", ext: ".ts", content: `import { signal } from '@angular/core';\nexport class X { v = signal(0); }\n` },
  { id: "import-computed-effect", kind: "catch", ext: ".ts", content: `import { computed, effect } from '@angular/core';\nexport class X {}\n` },
  { id: "import-inject", kind: "catch", ext: ".ts", content: `import { inject } from '@angular/core';\nexport class X { svc = inject(S); }\n` },
  { id: "import-DestroyRef", kind: "catch", ext: ".ts", content: `import { DestroyRef } from '@angular/core';\nexport class X {}\n` },
  { id: "import-toSignal", kind: "catch", ext: ".ts", content: `import { toSignal } from '@angular/core/rxjs-interop';\nexport class X { v = toSignal(this.o$); }\n` },
  { id: "bootstrapApplication", kind: "catch", ext: ".ts", content: `import { bootstrapApplication } from '@angular/platform-browser';\nbootstrapApplication(AppComponent);\n` },
  { id: "afterNextRender", kind: "catch", ext: ".ts", content: `afterNextRender(() => {});\n` },
  { id: "functional-guard", kind: "catch", ext: ".ts", content: `export const guard: CanActivateFn = () => true;\n` },
  { id: "hostDirectives", kind: "catch", ext: ".ts", content: `@Component({ hostDirectives: [T] })\nexport class C {}\n` },
  { id: "NgOptimizedImage", kind: "catch", ext: ".ts", content: `import { NgOptimizedImage } from '@angular/common';\n` },
  { id: "html-@if", kind: "catch", ext: ".html", content: `<div>@if (x) { <span>a</span> }</div>\n` },
  { id: "html-@for", kind: "catch", ext: ".html", content: `<div>@for (i of items; track i) { <span>{{ i }}</span> }</div>\n` },
  { id: "html-@switch", kind: "catch", ext: ".html", content: `<div>@switch (x) { @case (1) { <span>a</span> } }</div>\n` },
  { id: "html-@defer", kind: "catch", ext: ".html", content: `<div>@defer { <heavy-cmp /> }</div>\n` },
  { id: "html-@let", kind: "catch", ext: ".html", content: `<div>@let n = user.name; <span>{{ n }}</span></div>\n` },
  { id: "leak-subscribe", kind: "catch", ext: ".ts", content: `@Component({ selector: 'x', template: '' })\nexport class X {\n  ngOnInit() { this.svc.stream().subscribe((d) => this.d = d); }\n}\n` },

  // Идиоматичный Angular 11 и ловушки на ложные срабатывания — должно молчать.
  { id: "clean-ngOnDestroy", kind: "clean", ext: ".ts", content: `@Component({ selector: 'x', template: '' })\nexport class X implements OnDestroy {\n  private sub = new Subscription();\n  ngOnInit() { this.sub.add(this.svc.stream().subscribe()); }\n  ngOnDestroy() { this.sub.unsubscribe(); }\n}\n` },
  { id: "clean-first", kind: "clean", ext: ".ts", content: `@Component({ selector: 'x', template: '' })\nexport class X {\n  ngOnInit() { this.svc.getAll().pipe(first()).subscribe((d) => this.d = d); }\n}\n` },
  { id: "clean-take1", kind: "clean", ext: ".ts", content: `@Component({ selector: 'x', template: '' })\nexport class X {\n  ngOnInit() { this.svc.getAll().pipe(take(1)).subscribe((d) => this.d = d); }\n}\n` },
  { id: "clean-html", kind: "clean", ext: ".html", content: `<div *ngIf="a"><span *ngFor="let i of items">{{ i | date }}</span></div>\n` },
  { id: "clean-ts-no-component", kind: "clean", ext: ".ts", content: `export class XService {\n  go() { this.http.get('/x').subscribe(); }\n}\n` },
  { id: "clean-bootstrapModule", kind: "clean", ext: ".ts", content: `import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';\nplatformBrowserDynamic().bootstrapModule(AppModule);\n` },
  { id: "clean-resource-method", kind: "clean", ext: ".ts", content: `export class ApiClient {\n  r() { return this.http.resource('x'); }\n}\n` },
  { id: "clean-destroyRef-word", kind: "clean", ext: ".ts", content: `export class X {\n  describe() { return 'DestroyRef is 16+'; }\n}\n` },
];

// ---- angular_check: структурные дефекты и чистые воркспейсы ----
const checkCases: CheckCase[] = [
  {
    id: "undeclared",
    kind: "catch",
    files: {
      "src/app/app.module.ts": APP_MODULE,
      "src/app/x.component.ts": COMPONENT,
      "src/app/orphan.component.ts": `import { Component } from '@angular/core';\n@Component({ selector: 'app-orphan', template: '' })\nexport class OrphanComponent {}\n`,
    },
  },
  {
    id: "impure-pipe",
    kind: "catch",
    files: {
      "src/app/app.module.ts": `import { NgModule } from '@angular/core';\nimport { BrowserModule } from '@angular/platform-browser';\nimport { XComponent } from './x.component';\nimport { P } from './p.pipe';\n@NgModule({ declarations: [XComponent, P], imports: [BrowserModule] })\nexport class AppModule {}\n`,
      "src/app/x.component.ts": COMPONENT,
      "src/app/p.pipe.ts": `import { Pipe } from '@angular/core';\n@Pipe({ name: 'p', pure: false })\nexport class P {}\n`,
    },
  },
  {
    id: "browsermodule-feature",
    kind: "catch",
    files: {
      "src/app/app.module.ts": APP_MODULE,
      "src/app/x.component.ts": COMPONENT,
      "src/app/f/f.module.ts": `import { NgModule } from '@angular/core';\nimport { BrowserModule } from '@angular/platform-browser';\nimport { XComponent } from '../x.component';\n@NgModule({ declarations: [XComponent], imports: [BrowserModule] })\nexport class FModule {}\n`,
    },
  },
  {
    id: "missing-commonmodule",
    kind: "catch",
    files: {
      "src/app/app.module.ts": `import { NgModule } from '@angular/core';\nimport { BrowserModule } from '@angular/platform-browser';\n@NgModule({ declarations: [], imports: [BrowserModule] })\nexport class AppModule {}\n`,
      "src/app/f/f.module.ts": `import { NgModule } from '@angular/core';\nimport { XComponent } from '../x.component';\n@NgModule({ declarations: [XComponent], imports: [] })\nexport class FModule {}\n`,
      "src/app/x.component.ts": `import { Component } from '@angular/core';\n@Component({ selector: 'app-x', template: \`<div *ngIf="a">{{ b | date }}</div>\` })\nexport class XComponent {}\n`,
    },
  },
  { id: "clean-simple", kind: "clean", files: { "src/app/app.module.ts": APP_MODULE, "src/app/x.component.ts": COMPONENT } },
  {
    id: "clean-shared-reexport",
    kind: "clean",
    files: {
      "src/app/app.module.ts": APP_MODULE,
      "src/app/x.component.ts": COMPONENT,
      "src/app/shared/shared.module.ts": `import { NgModule } from '@angular/core';\nimport { CommonModule } from '@angular/common';\n@NgModule({ imports: [CommonModule], exports: [CommonModule] })\nexport class SharedModule {}\n`,
      "src/app/f/f.module.ts": `import { NgModule } from '@angular/core';\nimport { SharedModule } from '../shared/shared.module';\nimport { FComponent } from './f.component';\n@NgModule({ declarations: [FComponent], imports: [SharedModule] })\nexport class FModule {}\n`,
      "src/app/f/f.component.ts": `import { Component } from '@angular/core';\n@Component({ selector: 'app-f', template: \`<div *ngIf="a"></div>\` })\nexport class FComponent {}\n`,
    },
  },
  {
    id: "barrel-empty-undeclared",
    kind: "catch",
    files: {
      "src/app/app.module.ts": `import { NgModule } from '@angular/core';\nimport { BrowserModule } from '@angular/platform-browser';\nconst COMPONENTS = [];\n@NgModule({ declarations: COMPONENTS, imports: [BrowserModule] })\nexport class AppModule {}\n`,
      "src/app/lone.component.ts": `import { Component } from '@angular/core';\n@Component({ selector: 'app-lone', template: '' })\nexport class LoneComponent {}\n`,
    },
  },
  {
    id: "clean-barrel-unresolvable",
    kind: "clean",
    files: {
      "src/app/app.module.ts": `import { NgModule } from '@angular/core';\nimport { BrowserModule } from '@angular/platform-browser';\n@NgModule({ declarations: SHARED_COMPONENTS, imports: [BrowserModule] })\nexport class AppModule {}\n`,
      "src/app/lone.component.ts": `import { Component } from '@angular/core';\n@Component({ selector: 'app-lone', template: '' })\nexport class LoneComponent {}\n`,
    },
  },
  {
    id: "clean-barrel-resolved",
    kind: "clean",
    files: {
      "src/app/app.module.ts": `import { NgModule } from '@angular/core';\nimport { BrowserModule } from '@angular/platform-browser';\nimport { XComponent } from './x.component';\nconst COMPONENTS = [XComponent];\n@NgModule({ declarations: COMPONENTS, imports: [BrowserModule] })\nexport class AppModule {}\n`,
      "src/app/x.component.ts": COMPONENT,
    },
  },
  {
    id: "clean-spec-not-flagged",
    kind: "clean",
    files: {
      "src/app/app.module.ts": APP_MODULE,
      "src/app/x.component.ts": COMPONENT,
      "src/app/x.component.spec.ts": `import { Component } from '@angular/core';\nimport { TestBed } from '@angular/core/testing';\n@Component({ selector: 'app-host', template: '' })\nexport class HostComponent {}\ndescribe('x', () => { it('t', () => TestBed.configureTestingModule({})); });\n`,
    },
  },
  {
    id: "clean-multi-class",
    kind: "clean",
    files: {
      "src/app/app.module.ts": APP_MODULE,
      "src/app/x.component.ts": COMPONENT,
      "src/app/multi.ts": `import { Component, Directive } from '@angular/core';\n@Component({ selector: 'a', template: '' })\nexport class MultiComponent {}\n@Directive({ selector: '[b]' })\nexport class MultiDirective {}\n`,
    },
  },
  {
    id: "unused-service",
    kind: "catch",
    files: {
      "src/app/app.module.ts": APP_MODULE,
      "src/app/x.component.ts": COMPONENT,
      "src/app/dead.service.ts": `import { Injectable } from '@angular/core';\n@Injectable({ providedIn: 'root' })\nexport class DeadService {}\n`,
    },
  },
  {
    id: "clean-used-service",
    kind: "clean",
    files: {
      "src/app/app.module.ts": APP_MODULE,
      "src/app/x.component.ts": `import { Component } from '@angular/core';\nimport { UsedService } from './used.service';\n@Component({ selector: 'app-x', template: '' })\nexport class XComponent { constructor(private svc: UsedService) {} }\n`,
      "src/app/used.service.ts": `import { Injectable } from '@angular/core';\n@Injectable()\nexport class UsedService {}\n`,
    },
  },
  {
    id: "clean-barrel-provider-service",
    kind: "clean",
    files: {
      "src/app/app.module.ts": `import { NgModule } from '@angular/core';\nimport { BrowserModule } from '@angular/platform-browser';\nimport { XComponent } from './x.component';\nimport { fakeBackendProvider } from './_helpers';\n@NgModule({ declarations: [XComponent], imports: [BrowserModule], providers: [fakeBackendProvider] })\nexport class AppModule {}\n`,
      "src/app/x.component.ts": COMPONENT,
      "src/app/_helpers/fake-backend.ts": `import { Injectable } from '@angular/core';\n@Injectable()\nexport class FakeBackendInterceptor {}\nexport const fakeBackendProvider = { useClass: FakeBackendInterceptor };\n`,
      "src/app/_helpers/index.ts": `export * from './fake-backend';\n`,
    },
  },
  {
    id: "cyclic-modules",
    kind: "catch",
    files: {
      "src/app/app.module.ts": APP_MODULE,
      "src/app/x.component.ts": COMPONENT,
      "src/app/a/a.module.ts": `import { NgModule } from '@angular/core';\nimport { BModule } from '../b/b.module';\n@NgModule({ declarations: [], imports: [BModule] })\nexport class AModule {}\n`,
      "src/app/b/b.module.ts": `import { NgModule } from '@angular/core';\nimport { AModule } from '../a/a.module';\n@NgModule({ declarations: [], imports: [AModule] })\nexport class BModule {}\n`,
    },
  },
  {
    id: "clean-linear-modules",
    kind: "clean",
    files: {
      "src/app/app.module.ts": APP_MODULE,
      "src/app/x.component.ts": COMPONENT,
      "src/app/a/a.module.ts": `import { NgModule } from '@angular/core';\nimport { BModule } from '../b/b.module';\n@NgModule({ declarations: [], imports: [BModule] })\nexport class AModule {}\n`,
      "src/app/b/b.module.ts": `import { NgModule } from '@angular/core';\n@NgModule({ declarations: [], imports: [] })\nexport class BModule {}\n`,
    },
  },
];

describe("angular11 evaluation corpus — write-check", () => {
  for (const c of writeCases) {
    it(`${c.kind === "catch" ? "catches" : "stays silent on"}: ${c.id}`, () => {
      const findings = checkContent(c.ext, c.content);
      if (c.kind === "catch") expect(findings.length).toBeGreaterThan(0);
      else expect(findings).toEqual([]);
    });
  }
});

describe("angular11 evaluation corpus — angular_check", () => {
  for (const c of checkCases) {
    it(`${c.kind === "catch" ? "catches" : "stays silent on"}: ${c.id}`, () => {
      const findings = analyzeWorkspace(workspace(c.files)).findings;
      if (c.kind === "catch") expect(findings.length).toBeGreaterThan(0);
      else expect(findings).toEqual([]);
    });
  }
});
