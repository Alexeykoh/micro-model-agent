# Системный плагин Angular 11 — знание, проверки, скаффолд

_Дата: 2026-10-16. Ветка: `feat/angular11-plugin`._

## 1. Что и зачем

Агент на маленькой модели (Qwen3.5-9B, 32K–64K) плохо помнит особенности **Angular 11** —
это classic-NgModule-эпоха, радикально отличная от Angular 14+, на которой написаны
почти все обучающие материалы модели. Типичные следствия:

- агент тянет `standalone: true` (появился в 14), `takeUntilDestroyed` (16), `provideRouter`
  (14+), `@if`/`@for` control flow (17) — код не компилируется на 11;
- не объявляет компонент/пайп в `declarations`, забывает `CommonModule` в фиче-модуле;
- пишет `BrowserModule` в ленивый модуль, не снимает подписки, не ставит `OnPush`;
- путает синтаксис lazy-loading (`loadChildren` строкой вместо `() => import(...).then(m => m.X)`).

Корректность фреймворковых идиом нельзя оставлять на память модели: у MMA уже есть
принцип — **знание сжато в промпте, а корректность отдана детерминированным проверкам
в коде** (`lint-on-write`, LSP-диагностика). Этот плагин продолжает тот же принцип для
Angular 11.

Что **уже** есть и не дублируется:

- **LSP для Angular** — `.html`/`.ts` в Angular-воркспейсе обслуживает
  `@angular/language-server` (`src/modules/lsp/config.ts`), диагностика докатывается
  после write/edit (`src/modules/lsp/module.ts:213`). Семантику шаблонов и типов
  плагин не проверяет — это остаётся LSP.
- **`lint-on-write`** — синтаксис + проектный lint + дебаунснутый `tsc`.
- **Детект тулчейна** — `@angular/core@11` на Node 16 уже распознаётся
  (`src/modules/lsp/toolchain.ts`).

Плагин добавляет только то, чего нет: **знание Angular 11**, **архитектурный анализ
воркспейса**, **идиомные проверки при записи**, **генерацию корректного каркаса**.

## 2. Целевой контракт (нормативно)

**A11-1. Носитель — один builtin-плагин `angular11`.** Каталог
`src/modules/plugins/builtin/angular11/`, регистрируется рядом с
`lint-on-write`/`notify` в `registerModuleToolsAndPlugins`
(`src/core/bootstrap/modules-phase.ts:215-216`).

**A11-2. Выключен по умолчанию.** Имя `angular11` — в `DEFAULTS.plugins.disabled`
(`src/config/defaults.ts`). Включение/выключение идёт **единственным существующим**
путём — deny-list `plugins.disabled` (`mma plugins enable|disable`, `/plugins`, тумблер
в вебе; живой эффект `plugins.gate`). Отдельного механизма «включённости» у плагина нет.

**A11-3. Плагин активен только в Angular-воркспейсе.** Детект — маркер `angular.json`
вверх по дереву от `ctx.baseDir` (та же логика, что `isAngularProject` в
`src/modules/lsp/config.ts`). Вне Angular-проекта инструменты и проверки — **no-op**
(не ошибка, не предупреждение при каждом вызове).

> **Исключение по построению:** блок промпта (`onBuildPrompt`) статичен — хук вызывается
> без `ctx` и не знает воркспейс. Поэтому блок присутствует всё время, пока плагин
> включён. Это приемлемо: пользователь включает плагин осознанно, в Angular-репозитории.
> Блок делается коротким.

**A11-4. Никакого дублирования LSP.** Проверки при записи ловят только
**архитектурные идиомы** Angular 11 (см. §3), а не типы и не семантику шаблонов.
Пересечение с `lint-on-write`/LSP не создаётся: плагин не парсит TS-типы и не гоняет
компилятор — только дешёвые текстовые/AST-lite эвристики.

**A11-5. Скаффолд пишет только файлы.** `angular_scaffold` генерирует корректные файлы по
канону 11; **сам в NgModule ничего не вписывает** — правку модуля делает модель, видя
diff. Авто-вайринг отложен (см. §7).

**A11-6. Enforcement — в одной точке.** Тул `angular_scaffold` объявляет
`security: { caps: [{fs:"write"}], pathArgs: ["path"] }`; проверки scope/protected-путей
применяет `ToolExecutor.execute()` (`enforcePathArgs`), а **не хендлер**. Плагин не
импортирует security-примитивы.

**A11-7. Версия ≠ 11 — предупреждение, не отказ.** Если `package.json` даёт другую
мажорную версию `@angular/core`, `angular_check` об этом явно сообщает, но продолжает
анализ (идиомы 12+ всё ещё частично полезны).

**A11-8. Пользовательские строки — через `t()`.** Ключи в `src/i18n/en.json` и
`src/i18n/ru.json` симметричны (`tests/i18n.test.ts`). Прямой `console.*` запрещён
(`tests/output/no-direct-console.test.ts`); сигналы — через `ctx.logger`.

## 3. Возможности (v1)

| # | Возможность | Точка входа | Что делает |
|---|---|---|---|
| F1 | Знание Angular 11 | `onBuildPrompt` | короткий prescriptive-блок `[ANGULAR 11]`: NgModules (standalone НЕ существует), `BrowserModule` vs `CommonModule`, DI `providedIn`/иерархия, pure/impure pipes, guards/interceptors как `@Injectable`-классы, RxJS 6 + `async` pipe + отписка, lazy `loadChildren: () => import(...).then(m => m.X)`, `OnPush`, AOT/Node 16/TS 4.0 |
| F2 | Анализ воркспейса | тул `angular_check` | версия Angular; карта NgModule-ов (declarations/imports/exports/providers); типовые дефекты: не объявленный компонент/пайп, `*ngIf` в фиче без `CommonModule`, `BrowserModule` в lazy-модуле, impure pipe без нужды. Read-only, `cacheable` |
| F3 | Проверка при записи | `onAfterTool` | `.ts`/`.html` внутри Angular-воркспейса → дешёвый реестр архитектурных идиом, вывод дописывается в `result.output` (как `lint-on-write`) |
| F4 | Скаффолд | тул `angular_scaffold` | генерация component / pipe / module / service / directive / guard по канону 11; **только файлы**, без вайринга |

### Файлы

| Файл | Ответственность |
|---|---|
| `src/modules/plugins/builtin/angular11/index.ts` | entry: метаданные, `isBuiltin`, сборка хуков и `getToolDefinitions`; тонкий |
| `.../knowledge.ts` | текст блока `[ANGULAR 11]` (F1) |
| `.../detect.ts` | `isAngularProject(baseDir)`, `angularMajorVersion(baseDir)` |
| `.../analyze.ts` | F2: сбор карты модулей и дефектов |
| `.../rules.ts` | F3: реестр идиомных правил (расширяемый: правило = `match + message`) |
| `.../scaffold.ts` | F4: генераторы файлов |

Правило ≤300 строк (`tests/arch/file-size.test.ts`) — причина существования каталога, а не
одного файла.

## 4. Определение «готово» (rule 7)

- `bun test` зелёный · `bun run quality` зелёный.
- **Тест, падающий без правки:** `DEFAULTS.plugins.disabled` содержит `angular11`
  (default-disable); детект версии Angular; сборка карты модулей и каждый дефект F2 на
  фикстурах; каждое правило F3 срабатывает на «плохом» и молчит на «хорошем»; F4
  генерирует файлы без `standalone`/`takeUntilDestroyed`/`provideRouter`.
- Пользовательский текст: `angular_check`/`angular_scaffold` читаемы, обратимость
  (скаффолд не перезаписывает существующий файл без явного флага), i18n en/ru.
- Модельная сторона: вывод `angular_check` ограничен (не заливает контекст); блок F1 —
  короткий; ошибки устранимы (тул говорит, что именно чинить).

## 5. Не-цели

- Проверка типов и семантика шаблонов — это LSP.
- Поддержка Angular ≠ 11 (12+, standalone, signals) — вне v1; версионный гейт только
  предупреждает.
- Авто-вайринг в NgModule (см. A11-5).
- Запуск `ng build`/`ng test` — не задача плагина.

## 6. Волны

| Волна | Результат | Зависит |
|---|---|---|
| W1 | entry + `detect` + регистрация + default-disable + блок знания + тесты гейта | — |
| W2 | `angular_check` (карта модулей + дефекты) + тесты фикстур | W1 |
| W3 | `rules.ts` + `onAfterTool` + тесты «плохой/хороший» | W1 |
| W4 | `angular_scaffold` + тесты генерации | W1 |

Каждая волна — проверяемый результат; ветка одна (`feat/angular11-plugin`), но коммиты
раздельные.

## 7. Открытые вопросы

- **Живой прогон** требует Angular 11 на Node 16. Пока не решено — покрываем фикстурами;
  `ng build`-поведение не проверяется. Триггер: появится тестовый проект.
- **Авто-вайринг в NgModule** — возможная следующая итерация после обкатки F4.
