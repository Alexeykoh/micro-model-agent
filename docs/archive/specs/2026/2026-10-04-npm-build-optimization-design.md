# npm Build Optimization (B) — Design

Ветка: `chore/npm-build-optimization`. Дата: 2026-10-04.

## Проблема

Прод-пакет (`bun run build:prod` → `dist/`) — **8.17 MB / 57 файлов**:

- `dist/main.js` — **7.68 MB**, unminified. Доминанта — встроенный `js-tiktoken`
  (все rank-таблицы, ~5.6 MB), хотя он уже runtime-зависимость;
- браузерные ассеты ~400 KB (`hljs.js` 129 K, `styles.css` 83 K, наши `.js`);
- i18n JSON 322 KB (pretty-printed; и внутри `main.js`, и копией в `dist/i18n`);
- мусор: `dist/assets/js/core/store/types.js` 0 байт;
- `build:prod` **не чистит `dist`** — выводы прежнего `build:tsc` протекают в пакет (+2 MB).

## Цели

1. **Размер** — минификация main.js/ассетов/JSON, вынос зависимостей.
2. **Обфускация (лёгкая)** — mangling идентификаторов минификатором. **Не** шифрование:
   код исполняется на машине пользователя, ключ был бы рядом. `javascript-obfuscator`
   не берём (string-encoding/control-flow против целей размера и старта).
3. **Скорость старта** — не парсить 5.6 MB tiktoken на каждом запуске.
4. **Чистота** — детерминированный пайплайн, `clean` перед сборкой, без пустых/дублей.

**Безопасность:** ничего не докачивается в рантайме. Все внешние зависимости
приходят с `npm install` (все уже в `dependencies`); браузерные ассеты и i18n —
из пакета.

## Решение

### B1. Бандл зависимостей

`build:bundle` → `bun build ./src/cli/main.ts --outfile ./dist/main.js --target node
--format esm --packages external`. Зависимости резолвятся из `node_modules` на
машине пользователя (ставятся npm'ом), в бандл не вшиваются. `main.js` 7.68 → 1.73 MB.
`bin/mma.mjs` ре-экзекьютится под Bun — резолв CJS/ESM штатный; Node-фолбэк тоже
поддерживает (deps ESM/CJS совместимы).

### B2. Минификация

Новый `scripts/optimize-dist.ts` (esbuild API) обходит `dist/**` и перезаписывает
`*.js`, `*.mjs`, `*.css`, `*.json` минифицированным видом (`--minify`, без sourcemaps).
Это даёт и mangling (лёгкая обфускация). `main.js` 1.73 → ~1.31 MB.

### B3. Чистота пайплайна

- `scripts/clean.ts` — портативное удаление `dist` (вместо Windows-only `cmd /c`).
- `build:prod` = `clean → bundle → frontend → copy-assets → optimize` (opt last, чтобы
  минифицировать и скопированные `.js`/`.json`).
- `build-frontend.ts` пропускает пустые транспиляции (type-only `types.ts` → 0 байт).

### B4. Ленивый/лёгкий tiktoken

`src/llm/token-counter.ts` переходит с полного `js-tiktoken` на
`js-tiktoken/lite` + `js-tiktoken/ranks/cl100k_base` (внешний модуль). Синхронный
`count()` сохраняется; на старте парсится ~1.1 MB вместо ~5.6 MB. `cl100k_base` —
документированный фолбэк и для локальных моделей, о чём и так шла речь; для
o200k-моделей (OpenAI GPT-4o-класс) счёт меняется в пределах нескольких процентов.

## Ожидаемый результат

| Метрика | До | После |
|---|---|---|
| Пакет | 8.17 MB | ~2.0–2.2 MB |
| `main.js` | 7.68 MB | ~1.31 MB |
| Парсинг на старте | ~7.7 MB | ~2.4 MB |
| `dist` чистится перед сборкой | нет | да |

## Интеграция (три измерения)

1. **Пользователь:** `npm i` ставит зависимости как обычно; запуск не требует сети;
   CLI/REPL/web/one-shot без изменений; `--json` не трогаем.
2. **Модель:** не затрагивается (сборка, не контекст). Точность подсчёта токенов —
   cl100k для всех моделей (было cl100k для локальных, o200k для gpt-4o-класса).
3. **Смежные модули:** меняются `package.json` (скрипты, devDep esbuild),
   `scripts/{build-frontend,clean,optimize-dist}.ts`, `src/llm/token-counter.ts`,
   `tsconfig.build.json` не трогаем. `build:tsc` остаётся для тестов/dev.

## Вне scope

- Реальный крипто-защиты нет; обфускация — только mangling.
- Оптимизация размера i18n (сжатие/дедуп словарей) — отдельная задача.
- Кросс-платформенная публикация/CI подписи — не здесь.
