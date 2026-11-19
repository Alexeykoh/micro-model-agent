# mma web — тестовые прогоны 2026-11-02

Сводный отчёт по трём живым сессиям `mma web` в браузере (Playwright MCP). Цель — один и
тот же сценарий: многостраничный сайт веломагазина на Next.js + Tailwind + shadcn/ui +
lucide, с каталогом, фильтрами, поиском, корзиной и моками.

Детальные логи и полные находки (локально, вне git — `_testing/`):
`_testing/mma-web-agent-report.md` (nemotron), `_testing/mma-web-agent-report-mimo.md`,
`_testing/mma-web-agent-report-deepseek.md`.

## Стенд

| Параметр | Значение |
|---|---|
| Запуск | `bun run src/cli/main.ts web -p <port> --no-open -d <workspace>` |
| Изолированный конфиг | `%TEMP%\opencode\mma-*-stand` (`MMA_CONFIG_DIR`) |
| Модели | `lmstudio/nvidia-nemotron-3.5-bolt-e4b`, `opencode-go/mimo-v2.6-flash`, `opencode-go/deepseek-v4.1-flash` |
| Контекст | 80 000 (`contextAuto=false`) для всех прогонов |
| UI | Chromium через Playwright MCP |
| Правило | Оператор не пишет код за агента: только сообщения, ответы на вопросы, остановка зацикленных ходов и проверка результата |

## Итоги трёх прогонов

| Прогон | Модель | Результат | Блокер |
|---|---|---|---|
| 1 | `nvidia-nemotron-3.5-bolt-e4b` | каркас, 2 страницы, `build` зелёный | Tailwind 4 не скомпилирован, сайт без стилей; модель зациклилась на `layout.tsx`/`:root` |
| 2 | `mimo-v2.6-flash` | 6/9 шагов плана, код частично | `400 Upstream response was not valid JSON` на втором/следующем ходе (модель/провайдер) |
| 3 | `deepseek-v4.1-flash` | полноценный styled-сайт, 30 маршрутов, 12 товаров | фото picsum 403 в этой сети; локальные SVG не успели |

### Что получилось у DeepSeek

- `src/lib/bikes.ts` — 12 велосипедов + хелперы.
- `/catalog` — поиск, фильтры категория/бренд/цена, сортировка, счётчик.
- `/catalog/[slug]` — 12 SSG-страниц товаров.
- Корзина: `localStorage`, счётчик в шапке, `/cart` с количеством/суммой/удалением/очисткой.
- `/parts`, `/service`, `/service/build`, `/warranty`, `/delivery`, `/contacts`, `/about`,
  `/blog`, `/jobs`, `/catalog/city`, `/catalog/mountain` — 200.
- `tsc --noEmit` — 0, `npm run build` — exit 0, 30 маршрутов.
- Живая проверка: поиск «Rockrider» → «1 из 12»; «Городские» → «4 из 12»; товар → корзина →
  счётчик 1 → итог 189 000 ₽; все ссылки шапки/подвала 200.

Скриншоты: [`assets/web-agent-2026-11-02/deepseek-home.png`](./assets/web-agent-2026-11-02/deepseek-home.png)
(styled) · [`assets/web-agent-2026-11-02/nemotron-unstyled.png`](./assets/web-agent-2026-11-02/nemotron-unstyled.png)
(тот же сценарий без Tailwind).

## Находки: MMA (harness)

- **MCP-тулы в дефолтном наборе.** 27 тулов Playwright с тегом `code` раздували схему до 65;
  MiMo ломался на втором ходе. Исправлено: тег `mcp`, доступ через `enable_tools ["mcp"]`.
- **`path: undefined` создаёт файл `undefined`.** `ToolExecutor.enforcePathArgs` пропускал
  нестроковые значения; `write_file` делал `String(undefined)`. Исправлено guard'ом по
  `required` из схемы + защитой в `write_file`/`edit_file`.
- **Pre-write проверка только синтаксическая.** `preValidateSyntax` (`bun build`) не видит
  типов; LSP/tsc — post-write, `success:true`, отката нет. Долг: `checkDraft` на
  `LspConnection.syncDocument` + запрет записи/откат при ошибках.
- **`LspClient.checkFile()` читает с диска.** API `syncDocument(path, text)` для черновика
  есть, но не используется.
- **Нет финального гейта по `typecheckFailures` без плана.** Ошибки типов блокируют только
  `plan_step done`; ответ «готово» проходит.
- **Локальные HTTP-проверки затруднены.** `web_fetch`/`browser` блокируют localhost,
  `node`/`powershell` в blacklist; DeepSeek обошёл через `bun`/`npx tsx` + fetch.
- **Playwright MCP без `--isolated`.** Профиль занят внешним Playwright — «Browser is already
  in use»; агент не может проверить UI, если тестировщик уже держит браузер.
- **`plan_step` и `kind=delete`.** Шаг с существующими файлами не закрывается; агент просит
  `status=skipped`.
- **Рекурсивное удаление.** `delete_file` не удаляет каталог, `rmdir /s /q` блокируется;
  stray `projects/...` остаётся.
- **Контекст в UI.** 80 000 показывается как 78K, загруженный — 1000.0K (расхождение).
- **`.mma/` в корне workspace** ломает `create-next-app .` (обход — подпапка).
- **Вложенный `AGENTS.md`** (Next 16) не читается: mma ищет только в корне `baseDir`.

## Находки: модель

- Nemotron: `--src-dir false`; shadcn заявлен, но не инициализирован; Tailwind 4 —
  `tailwind.config.ts` и `:root` вместо `@theme`; каталог с «мёртвыми» фильтрами; ложное
  «задача выполнена» при ошибках; 51 итерация без верного диагноза.
- MiMo: стабильный `400 Upstream response was not valid JSON` на новом ходе; минимальные
  запросы к тому же endpoint проходят — дефект модели/маршрута.
- DeepSeek: создал stray `projects/...`; фото оставил на picsum (403 в этой сети); локальные
  SVG не успел; местами слишком долго проверял (но в итоге честно).

## Находки: стек

- `tw-animate-css` (style-only exports) не резолвится Turbopack в Next 16.
- Next 16 + shadcn CSS: Tailwind не компилируется (сырые `@theme`/`@custom-variant`), при
  зелёном build.
- Next 14 + Tailwind 3 + PostCSS (выбор DeepSeek) собрались и отрендерились без проблем.

## Исправлено в этой ветке

1. **MCP-тулы on-demand.** `src/modules/mcp/module.ts` — тег `mcp` вместо `code`/`research`;
   `src/tools/enable-tools.ts` — `mcp` в списке тегов. Гейт:
   `tests/mcp-tool-tags.test.ts` (2 теста).
2. **Guard обязательного path-аргумента.** `src/tools/executor.ts` — fail-closed по
   `parameters.required`; `src/tools/write-file.ts`, `src/tools/edit-file.ts` — отказ на
   пустой/нестроковый `path`. i18n: `tool.path_arg_invalid`. Гейт:
   `tests/tools/enforcement-path.test.ts` (+2 теста, 13 всего).

Проверка: `bun run typecheck` — 0; `bun test tests/tools/enforcement-path.test.ts
tests/mcp-tool-tags.test.ts` — 13 pass.

## Что осталось (в TODO)

- Pre-write `checkDraft` через LSP + откат/запрет записи при ошибках.
- Post-build гейт для веб-задач: CSS содержит utilities, страница не пустая.
- Финальный гейт по `typecheckFailures` без плана.
- Localhost-проверки для веб-разработки (разрешить агентy свой сервер).
- `--isolated` для MCP Playwright.
- Локальные изображения/заглушки вместо внешнего picsum.
- Вложенный `AGENTS.md` и `.mma/` при скаффолдинге.

## Операторские вмешательства

- Ответ на вопрос про `.mma` (проект в подпапке).
- 4+ остановки зацикленных ходов.
- Ручная правка `globals.css` (удаление `tw-animate-css`) — **откачена**, в зачёт агенту не идёт.
- Запуски `tsc`/`build`/`next start`, HTTP-проверки и скриншоты — только верификация.
