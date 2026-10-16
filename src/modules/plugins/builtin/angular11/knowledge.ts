// Блок знания Angular 11 для системного промпта (F1 плагина `angular11`).
//
// Текст статичен: `onBuildPrompt` вызывается без ctx и не знает воркспейс
// (см. §2 A11-3 спеки). Поэтому он короткий и prescriptive — модель 9B должна
// получить максимум пользы за минимум токенов. Английский — как у остальных
// промпт-блоков и builtin-скиллов (`typescript.md`).

/** Текст блока `[ANGULAR 11]`, добавляемый в системный промпт, пока плагин включён. */
export const ANGULAR11_KNOWLEDGE = `[ANGULAR 11]
This project uses Angular 11 — the classic NgModule era. APIs from Angular 14+ DO NOT EXIST here.

DO NOT use (they are 14+): standalone components, \`standalone: true\`, \`provideRouter\`,
\`inject()\` in field initializers, \`takeUntilDestroyed\`, \`@if\`/\`@for\`/\`@switch\` control flow,
required inputs, \`RouterModule.forRoot\` with provider functions. There are no signals.

Modules:
- Every component/directive/pipe must be declared in exactly one NgModule \`declarations\`.
- \`BrowserModule\` only in the root (AppModule). Feature modules import \`CommonModule\`.
- Template directives \`*ngIf\`, \`*ngFor\`, \`[ngClass]\` come from \`CommonModule\`; a feature
  module that uses them MUST import it, even if it declares the component.
- Lazy feature module MUST NOT import \`BrowserModule\` (use \`CommonModule\`).
- Lazy routes (v8+ syntax): \`loadChildren: () => import('./x/x.module').then(m => m.XModule)\`.

DI:
- Prefer \`@Injectable({ providedIn: 'root' })\` for singletons. Providers in a lazy module
  are scoped to that module's injector.
- Constructor injection with explicit types; \`@Optional()\`/\`@SkipSelf()\` where relevant.

Pipes:
- Pure by default — recompute only on input reference change. Use \`pure: false\` ONLY when the
  pipe depends on mutable state that changes outside its inputs; impure pipes run every CD cycle.
- A pipe used in a template must be declared in that component's module \`declarations\`.

RxJS 6:
- Subscribe in components and unsubscribe: capture \`Subscription\`, or \`subject.pipe(takeUntil(destroy$))\`
  and call \`next()\`/\`complete()\` in \`ngOnDestroy\`. There is no \`takeUntilDestroyed\`.
- Prefer the \`async\` pipe for template streams — it unsubscribes automatically.
- \`HttpInterceptor\` implements \`intercept(req, next)\` and returns \`Observable<HttpEvent<any>>\`.

Guards: classes with \`@Injectable({ providedIn: 'root' })\` implementing \`CanActivate\`,
\`CanActivateChild\`, \`CanDeactivate\`, \`Resolve\` — return \`boolean | Observable<boolean> | Promise<boolean>\`.

Change detection: default (zone.js). Use \`ChangeDetectionStrategy.OnPush\` for presentational
components with \`@Input()\`; with OnPush update inputs immutably.

Toolchain: Angular CLI 11, TypeScript ~4.0, RxJS ~6.5, Node 16, webpack 4. AOT is on in prod
builds; the template type checker is weak, so most template mistakes surface only at runtime.
`;
