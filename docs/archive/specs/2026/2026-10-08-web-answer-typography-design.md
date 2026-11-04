# Web Answer Typography & Markdown Robustness — Design

Date: 2026-10-08
Status: approved (approach A)
Branch: `feat/web-answer-typography`

## Problem

Live `mma web` final answers read as "каша" compared to opencode:

1. **Типографика плотная** — абзацы `margin: 4px`, `li margin: 1px`, заголовки почти
   не отличаются от текста; нет воздуха между блоками.
2. **Разметка ломается** — часть GFM, которую модель реально пишет, не парсится
   `smd.js` и выводится сырым текстом:
   - таблица без крайних `|` (`A | B` / `---|---`) → `<p>` с сырыми `|` и `<br>`;
   - списки `1)` и заголовки `##X` без пробела → сырой текст;
   - `.md p { white-space: pre-wrap }` сохраняет мягкие переносы строки как реальные
     `\n` (CommonMark: мягкий перенос = пробел) — простыня из коротких строк.

Evidence: реальные ответы из `~/.mma/sessions/*/session.jsonl`, отрендеренные через
`md.ts` (happy-dom). Стандартные заголовки/таблицы/вложенные списки/код — ок; сырые
маркеры появляются только на случаях выше.

## Goal

Финальный ответ модели в web читается как аккуратный markdown: воздух, ясная
иерархия, корректная разметка — без изменения контрактов и без новой зависимости.

## Non-goals

- Не меняем smd.js на другой парсер (см. вариант B).
- Не трогаем терминальный REPL-рендерер и `--json`.
- Не меняем контрастность токенов темы (отдельная задача) и системный промпт.
- Не меняем SSE/REST/схему `session.jsonl`.

## Design

### 1. Типографика (`src/modules/webui/assets/styles.css`, блок `.md`)

- `.md { line-height: 1.62 }`; первый/последний дочерний элемент без внешних отступов.
- `.md p { margin: 9px 0 }` и **убрать `white-space: pre-wrap`** (мягкий перенос =
  пробел); жёсткий перенос (`  ` + `\n`) smd и так отдаёт как `<br>`.
- Заголовки: `h1 1.5em / h2 1.28em / h3 1.12em / h4+ 1em`, `margin: 18px 0 8px`,
  `line-height: 1.3`, цвет `--fg`, вес 600.
- Списки: `margin: 8px 0; padding-left: 24px`; `li { margin: 3px 0 }`; `li > p { margin: 3px 0 }`.
- `blockquote`: `margin: 10px 0`, вертикальные паддинги; `hr: margin 16px 0`.
- Таблица: `margin: 10px 0`; `th { padding: 6px 14px 6px 0; border-bottom: 1px solid var(--border) }`;
  `td { padding: 5px 14px 5px 0 }` — линии-разделители, без полной сетки (STYLE.md).
- Код: inline как есть; `.codeblock { margin: 10px 0 }`.

### 2. Нормализация markdown (`src/modules/webui/assets/md-normalize.ts`, новый)

Чистый модуль, без DOM. Состояние — для потокового пути и сквозного текста:

- `MdNormalizer` с `push(chunk): string` и `flush(): string`; строка удерживается
  на один шаг (lookahead), чтобы понять таблицу по следующей строке.
- `normalizeMarkdown(text): string` = `push(text) + flush()` (для истории/готового текста).
- Правила (вне код-фенсов ``` / ~~~):
  1. Заголовок: `^(#{1,6})([^\s#].*)$` → `$1 $2`.
  2. Упорядоченный список: `^(\s*)(\d+)\)(\s+)` → `$1$2.$3`.
  3. Таблицы без внешних `|`:
     - `delimiter`-строка: `|`, `-`, `:`, пробелы, минимум один `|`;
     - `header`: строка с `|`, не delimiter, следующая непустая — delimiter → добавить
       внешние `|`;
     - после delimiter `tableActive=true`: все последующие `|`-строки получают внешние `|`;
     - пустая/иная строка или конец — `tableActive=false`.
  4. Код-фенсы трекаются (``` и ~~~), внутри ничего не правится.

### 3. Интеграция (`src/modules/webui/assets/md.ts`)

- `renderMarkdown(parent, text)` → `normalizeMarkdown(text)` до `write`.
- Потоковый `mountMarkdown`: один `MdNormalizer` на handle; `write(chunk)` →
  `parser_write(normalizer.push(chunk))`; `end()` → `parser_write(normalizer.flush())`
  перед `parser_end`.

### 4. Тесты

- `tests/webui-md-normalize.test.ts` (pure): таблица без внешних `|`, `1)`→`1.`,
  `##X`→`## X`, фенсы не трогаются, обычный текст не меняется, streaming push/flush
  склеивается в тот же результат, что сквозной `normalizeMarkdown`.
- `tests/webui-md-render.test.ts` (happy-dom): реальный ответ → есть `<table>`,
  в `textContent` нет сырых `|`/`**`/`##`; мягкий перенос абзаца схлопнут (нет `\n`).
- Guard в `tests/webui-assets.test.ts`: `.md p` без `white-space: pre-wrap` и наличие
  ключевых типографских деклараций.

## Risks

- Нормализация может задеть прозу с `|` (напр. `a | b` перед `---`). Правило требует
  delimiter-строку с `|`; одиночный `---` — это setext-заголовок, не таблица, поэтому
  ложных срабатываний на нём нет. Покрываем тестом.
- Уменьшение `pre-wrap`: если модель рассчитывала на жёсткие переносы без `  `, текст
  сольётся. Это соответствует CommonMark; жёсткие переносы и так работают.
