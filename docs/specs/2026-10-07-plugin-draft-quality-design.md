# Plugin draft quality & styling — дизайн

- **Дата:** 2026-10-07
- **Ветка:** `feat/plugin-draft-quality`
- **Статус:** утверждён («делай + стилизация»)

## Проблема

`define_capability` даёт малой модели написать себе тул-плагин в
`.mma/plugins/drafts/`, но качество кода почти не проверяется:

- `validateDraftSpec` (`src/modules/plugins/drafts.ts:94-111`) проверяет только
  **форму** (имя, непустые description/code, `parameters`-объект, ≥1 permission) —
  про сам код ни слова.
- Синтаксис не проверяется: «каша»/битый код (код внутри хендлера и т.п.) пишется
  на диск как есть.
- После согласия `define_capability` при `reloadDrafts().failed > 0` всё равно
  возвращает `success: true` (`src/tools/define-capability.ts:135-142`) — модель
  не получает **текст** ошибки и не может починить; битый черновик остаётся.
- Файл не форматируется: `.mma/` исключён из Biome (`biome.json` `!.mma`,
  `formatter.enabled: false`) и Prettier (`.prettierignore`), а `renderDraft`
  вставляет тело хендлера дословно (`drafts.ts:119-143`) — отсюда «паршивый
  / каша» вид.

## Цели / не-цели

**Цели:**

- Синтаксическая проверка тела хендлера **до записи**, с понятной ошибкой модели.
- Проверка загрузки **после согласия**; при провале — текст ошибки модели +
  откат битого черновика (не оставляем заведомо сломанный одобренный плагин).
- Аккуратный вид сгенерированного файла (нормализация отступов/пустых строк,
  обрезка хвостовых пробелов) без внешнего форматтера в рантайм-зависимостях.
- Контракт плагина в описании тула (что возвращать, какие поля `ctx`).

**Не-цели:**

- Полноценный форматтер (prettier/biome) в рантайме — не тащим тяжёлую зависимость.
- Семантическая проверка «делает ли тул что надо» — только исполнением; остаётся
  на согласии пользователя.
- Загрузка/исполнение черновика **до** согласия (инертность сохраняется).

## Решения

| Вопрос | Решение |
| --- | --- |
| L1 синтаксис | `Bun.Transpiler` поверх `async (ctx,args)=>{ … }`; Bun-only, иначе skip (fail-open) |
| L2 контракт | не нужен: файл рендерим сами по фиксированному шаблону |
| L3 загрузка | после `reloadDrafts()`: `failed>0` → ошибка модели + `host.remove(name)` |
| Форматирование | `normalizeDraftCode` (CRLF→LF, dedent, ≤1 пустая строка, trim EOL, финальный `\n`) + индент в `renderDraft` |
| Контракт | расширить `description` `define_capability` |

## Изменения

- `src/modules/plugins/drafts.ts`
  - `validateDraftCode(code): string | null` — синтаксис через `Bun.Transpiler`
    (обёртка-стрелка, чтобы `return` был валиден); нет Bun → `null`.
  - `normalizeDraftCode(code): string` — причёсывание.
  - `validateDraftSpec` вызывает `validateDraftCode` (форма → синтаксис).
  - `renderDraft` вставляет нормализованное тело с индентом.
  - `DraftHost` интерфейс + `lastError(name): string | null`.
- `src/modules/plugins/draft-host.ts`: реализация `lastError` (по
  `pluginManager.getFailures()` для `drafts/`).
- `src/tools/define-capability.ts`: при `failed>0` → `success:false`,
  `draft.capability_load_failed`, откат файла; расширен `description`.
- `src/cli/plugin-commands.ts`: при `failed>0` печатать причину загрузки.
- i18n `draft.capability_load_failed` (en+ru).

## Тесты

- `tests/plugin-drafts.test.ts` (+): `validateDraftCode` валиден/битый,
  `normalizeDraftCode` dedent/пустые строки/финальный `\n`.
- `tests/tools/define-capability.test.ts` (если нет — новый): провал загрузки →
  `success:false` + откат файла (host-стаб).
- Обновить существующие проверки `renderDraft` (если вид изменился).

## Версия / доки

- CHANGELOG **2.29.1** (MINOR — новое поведение/валидация).
- AGENTS.md — дополнить раздел Plugin Registry.
