# Стресс-тест mma web — отчёт 2026-10-27

Стенд: `mma web --no-open -p 8080`, рабочая папка `C:\Users\Alexe\Desktop\mma_test`
(Vite-проект `bicycle-landing-page`, 19 файлов), модель `deepseek-v4.1-flash`
(провайдер `opencode-go`), серверная ОС Windows.
Метод: 3 фоновых субагента (skills+plugins, indexer+sessions, HTTP-смоук web UI)
+ живые проверки (one-shot прогон, `/api/*`, рестарт сервера). Без Playwright e2e,
без мутаций реального `~/.mma` (пишущие проверки — только с `MMA_CONFIG_DIR`).

Предыстория в ветке: вмержен `fix/subagent-model-unavailable-hint` (читаемый хинт
при `model is unavailable` у субагента) в локальный `master`, пуш отложен.

## Критично / высоко

1. **Read-only CLI создаёт сессию → лавина удалений → EFAULT.** `plugins list`
   падает с `unhandledRejection: EFAULT ... rm '.../sessions/ses_...'`.
   Цепочка: `src/cli/main.ts:109` (синхронный `parse`, отказ → `unhandledRejection`)
   → `src/core/bootstrap/session-phase.ts:129-131` (безусловный `create()` при
   `autoSave`, даже для read-only) → `src/modules/session/manager.ts:342-353`
   (`enforceMaxSessions`: синхронный цикл `rmSync` без try/catch и батчинга) →
   `src/modules/session/store.ts:394-400` (голый `rmSync`). В реальном
   `~/.mma/sessions` — ~92k каталогов (копятся с 08.10.2026, чистка не запускалась);
   каждый запуск CLI добавляет сессию и пытается удалить десятки тысяч каталогов,
   первый занятый вебом каталог даёт EFAULT. Подтверждено двумя агентами +
   изолированный repro (`plugins list --all` с пустым конфигом: exit 0 **и +1
   сессия** — побочный эффект детерминирован).
2. **`-d/--dir` игнорируется `map`/`session`.** `src/cli/commands.ts:423`,
   `src/cli/session-commands.ts:43,62,120,167,184`, `src/cli/main.ts:116`:
   `bootstrap()` без аргументов, `-d` работает только для `web`/`serve`/промпта.
   Первый прогон `map summary -d .../mma_test` молча проиндексировал сам репозиторий
   (1728 файлов вместо 19), без варнинга. Правильный вызов — только смена cwd.
3. **`skills/loader.ts:44` — `readFileSync` без try/catch.** Рядом `statSync`
   обёрнут (`loader.ts:31-35`), чтение — нет. Один занятый/нечитаемый `.md`
   (типично при параллельном вебе) роняет весь скан скиллов и bootstrap.

## Средне

4. **`GET /api/sessions` — секунды вместо миллисекунд** (замеры 3.9 / 9.2 / 9.5с
   при остальных endpoint'ах <1с). Перф-гейта на LIST нет.
5. **Вопрос в чате нельзя отклонить на фронте** + fire-and-forget
   `POST /api/answer` (`assets/js/feed/question.ts:28-43`, `assets/js/api.ts:39`)
   — вопрос может «висеть»; серверный `deactivate` при этом чистит
   `pendingQuestions` (тест есть, фронта нет).
6. **`map <опечатка>` молча отдаёт `summary` с `ok:true`**
   (`src/modules/indexer/map-command.ts:41-42`). Фикс — ветка `default` →
   `ok:false` + hint `summary|refresh|find`.
7. **`session list` печатает усечённый id, `show` требует полный**
   (`src/cli/session-commands.ts:53` vs `63`; `export`/`delete` идут через
   `resolveSession`, `show` — нет). Скопированный из `list` id → `Session not found`.
8. **Стартовый варнинг про бюджет промпта вводит в заблуждение**
   (`src/core/bootstrap/modules-phase.ts:293-331`, `prompt.overflow.startup`).
   Нужно ~14739 при бюджете 13107, но карта `mma_test` — доли процента; львиная
   доля — фиксированный оверхед harness'а (тул-дефы, инструкции). При дефолтном
   окне 32768 варнинг — постоянный шум, а текст толкает чинить проект/конфиг.
9. **Скиллы: молчаливые дропы** (`loader.ts:50-74` — нет фронтматтера/`name`/
   `mma_version > 2` → `null` без варна/счётчика, в отличие от `getFailures()` у
   плагинов); рекурсия по симлинкам без защиты от петель (`loader.ts:25-48`);
   фронтматтер-парсер `^(\w+)` не принимает ключи с дефисом; shadowing без следа
   (`loader.ts:120-125`).

## Низко / инфо

10. a11y/шелл: `#sessPrev/#sessNext/#sessClose`, `textarea#inp` без `aria-label`
    (только `title`/`placeholder`); шелл `index.html` захардкожен по-английски до
    `loadI18n()`; `aria-checked` на plain `button` (`question.ts:90`); при упавшем
    `/api/i18n` — сырые `web.*`-ключи; REST-провал `status:0` виден только через
    SSE-баннер, глобального тоста нет.
11. Trace-панель скрыта на ≤760px (`styles.css:1874`) без UI-подсказки.
12. `session prune` без `--dry-run` удаляет без подтверждения
    (`session-commands.ts:194-201`).
13. `rotateOldSessions` (`store.ts:403-430`) при каждом старте делает полный
    `readdirSync` + сортировку — на 92k каталогов это тормозит каждый запуск CLI/веба.
14. `plugins/drafts.ts:69` (+137/151 проверить) — `unlinkSync` под `existsSync`
    без try/catch (TOCTOU с вебом).
15. `plugins/loader.ts:206` — синхронный `require` пользовательского кода в
    bootstrap без изоляции (зафиксировано в AGENTS.md как «disable ≠ sandbox»,
    для `plugins list` — известный риск).

## Чисто (проверено, проблем нет)

Security-заголовки на всех endpoint'ах; XSS-защита фронта (`textContent` /
`createTextNode`, инертный `DOMParser`, URL-allowlist); тёмная тема по дефолту
без вспышки; мобильные брейкпоинты; инкрементальная пересборка индекса
(подтверждена замерами ~1.7с и `incremental-rebuild.test.ts`); `map summary` /
`refresh` / `find` корректны; `prune --dry-run` считает верно (12 пустых в
песочнице); зрелость plugin manager (`getFailures`, `adoptPlugin`, дедуп semver).

## Отложено (по решению пользователя)

- Пуш мержа в `origin/master` — нет.
- Чистка 92k сессий в реальном конфиге — нет (даже `prune --dry-run` на боевом
  не запускался).
- Фиксы — нет, только фиксация. Кандидат №1: п.1 (не создавать сессию для
  read-only + батч/try-catch в `enforceMaxSessions` + `parseAsync`).
