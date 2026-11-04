# WebUI Frontend TypeScript Migration — Design

Ветка: `refactor/webui-frontend-ts`. Дата: 2026-10-04.

## Проблема

Браузерный фронтенд `mma web` (`src/modules/webui/assets/**`) — это ~45 ES-модулей
(~8.2k строк) на чистом JS **без статической типизации**. Бэкенд при этом strict TS.
Следствия:

- контракты (REST/SSE/`HostStateSnapshot`/config/сессии) на фронте дублируются «на память»
  и расходятся с бэкендом молча;
- опечатки в полях/методах DOM, `undefined`-deref, неверные аргументы ловятся только
  в рантайме (или никак);
- guard-тесты проверяют структуру (граф импортов, строки), но не типы.

## Цель

Перевести весь наш фронтенд на TypeScript со `strict: true`, сохранив:

- **нулевое изменение рантайм-контракта**: те же имена отдаваемых файлов
  (`/app.js`, `/js/foo.js`), тот же REST/SSE, те же сессии/конфиг;
- **живой `web:dev`** без шага сборки (Bun-транспиляция на лету);
- **рабочие тесты** `tests/webui-*` и guard-граф.

Вендоренные `smd.js`, `hljs.js` остаются `.js` (не типизируем). `index.html`/`styles.css`
не меняются.

## Решение

### Раскладка

- `src/modules/webui/assets/js/**/*.js` → `.ts` (инкрементально, снизу вверх).
- `app.js`, `md.js`, `setup.js` → `.ts`.
- `smd.js`, `hljs.js` — как есть.
- Импорты остаются с `.js`-суффиксами (`import { el } from "./dom.js"`): это валидно и
  для `tsc` (Bundler-резолюция мапит `.js` → `.ts`), и для браузера после транспиляции.

### Типы

- Новый `tsconfig.frontend.json`:
  - `lib: ["DOM", "DOM.Iterable", "ES2022"]`, `module: "ESNext"`,
    `moduleResolution: "Bundler"`, `strict: true`, `noEmit: true`;
  - `allowJs: true`, `checkJs: false` — позволяет **инкрементальную** миграцию:
    уже переведённые `.ts` проверяются строго, ещё не переведённые `.js` резолвятся,
    но не типизируются. После завершения миграции `allowJs` остаётся **только** ради
    импорта вендоренного `smd.js` из `md.ts` (наш код — весь `.ts`).
  - `skipLibCheck: true`, `resolveJsonModule: true`, `allowImportingTsExtensions: true`.
- Основной `tsconfig.json` **исключает** `src/modules/webui/assets/**` (иначе `document`
  не найдётся в node-проекте). Взамен `quality` запускает `tsc -p tsconfig.frontend.json`.
- Строгость — сразу `strict: true`. DOM-границы (`.value` на `HTMLElement`, `dataset`,
  `Event.key`, `querySelector`-результаты) закрываются точечными `as`/`unknown`-кастами,
  не тотальным `any`.
- Разделяемые контрактные типы (например `HostStateSnapshot`) можно тянуть `import type`
  из бэкенда — тип стирается при транспиляции, рантайм-связи не создаёт. Вводится
  тонкий баррель `assets/js/types.ts` для реэкспорта нужных бэкенд-типов.

### Пайплайн ассетов

- **Dev и тесты:** `loadAssets()` обходит `assets/**` и, встречая `.ts`, транспилит через
  `Bun.Transpiler` (`loader: "ts"`), отдавая `.js` под тем же ключом (`js/foo.js`).
  Живой `web:dev` (`bun --watch`) сохраняется, шага сборки нет. Строковые литералы
  сохраняются, поэтому строковые ассерты `tests/webui-assets.test.ts` не ломаются.
- **Prod:** новый `scripts/build-frontend.ts` обходит `.ts`, пофайлово транспилит в
  `dist/assets/**/*.js` (имена и граф модулей сохраняются), копирует `.js`-вендор, html,
  css. `build:prod` вызывает его вместо прямого копирования webui-части. В `dist`
  `loadAssets()` просто читает готовые `.js` — рантайм-ветка транспиляции там не нужна.

### Тесты и гейты

- `tests/webui-frontend-graph.test.ts` — научить читать `.ts` (спецификаторы `.js`
  маппить на соседний `.ts`).
- `tests/webui-assets.test.ts` — без смысловых изменений.
- `bun run quality` += `tsc -p tsconfig.frontend.json`.
- `bun build src/modules/webui/assets/app.js --target=browser` остаётся проверкой
  резолва всего графа (Bun сам транспилит TS).
- `node --check` по изменённым `.ts` больше не применим — его роль берёт `tsc`.

## Интеграция (три измерения)

1. **Пользователь:** ничего не меняется — те же URL, тот же UI, тот же `web:dev`.
2. **Модель:** не затрагивается (фронт не в контексте LLM).
3. **Смежные модули:** меняются только `assets.ts` (`loadAssets`), `scripts/copy-assets.ts`
   (webui-часть выделяется в `build-frontend.ts`), `tests/webui-frontend-graph.test.ts`,
   `tsconfig.json`, `package.json`, AGENTS/CHANGELOG. REST/SSE/сессии/плагины — без смены
   контрактов.

## Риски

- **Объём** (~45 файлов): снимается инкрементальной миграцией снизу вверх и `allowJs`.
- **DOM-шум** при strict: закрывается кастами на границе, разово.
- **Bun-зависимость `loadAssets`**: MMA и так ре-экзекьютится под Bun (`bin/mma.mjs`);
  в prod транспиляции нет вовсе.

## Вне scope (проект B)

minify, obfuscate, бандлинг, оптимизация npm-пакета — отдельная спека.
