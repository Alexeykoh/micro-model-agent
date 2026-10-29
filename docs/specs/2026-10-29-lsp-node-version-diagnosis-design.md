# LSP: честная причина «сервер не стартует» — версия Node и stderr

_Дата: 2026-10-29 · Ветка: `fix/lsp-node-version-diagnosis`_

## Проблема

`/lsp doctor` печатает «ок» для сервера, а `/lsp check` и веб-панель на каждом
файле отвечают «сервер ещё запускается». Живой случай (Windows, Node 16):
глобально установлен `typescript-language-server` последней версии, который
требует Node 18+ (4.x), 20+ (5.x), 22.22+ (6.x). Процесс падает на старте с
`SyntaxError`, `open()` не доходит до `initialize`, а `runCheckFiles` глотает
ошибку прогрева (`check-run.ts`, `.catch(() => {})`) и называет это холодным
стартом. Модель и пользователь видят «подождите» вместо причины.

Три дефекта, каждый самостоятельный, но видимые вместе:

1. **Ошибка прогрева не доходит до отчёта.** `warmWithin` возвращает только
   `boolean`: «не тёплый» неотличим от «прогрев упал». `health` не узнаёт о
   падении, `/lsp status` пишет «Все серверы работают», модель получает
   `lsp.check_cold` вместо `[LSP check failed: …]`.
2. **Причина падения не видна.** `lsp doctor` классифицирует ошибку в общий
   `server-error` и не показывает ни версию Node, ни stderr сервера (долг
   `lsp-stderr-in-doctor`). «Node слишком старый» и «битый конфиг» выглядят
   одинаково.
3. **Подсказка установки вредна.** Для npx-сервера `installCommandFor` советует
   `npm i -g typescript-language-server …` — то есть ровно ту версию, которая на
   этом Node не запускается.

## Что правильно

### Класс причины `node-too-old`

`LspFailureReason` получает значение `node-too-old`. Оно выставляется, когда
проба упала сообщением, характерным для краха JS-сервера на неподходящем
рантайме: `SyntaxError`, `Unexpected token`, `ERR_REQUIRE_ESM`,
`ERR_UNKNOWN_BUILTIN_MODULE`, `structuredClone is not defined`.

Классификация идёт **по сообщению**, а не по таблице «версия Node → версия
пакета»: таблица устаревает быстрее кода, а сообщение уже содержит факт краха.
Версия Node при этом показывается, но не является условием класса — иначе
Node 20 с `typescript-language-server@6` (нужен 22.22+) остался бы
неклассифицированным.

Критичная деталь: упавший сервер **не отвечает ошибкой рантайма**. Клиент видит
`LSP server exited` или `request timeout: initialize`, а `SyntaxError` остаётся
только в stderr. Поэтому классификатор получает `сообщение + stderrTail`, а
проверка на крах рантайма идёт **до** ветки `timeout` (таймаут — следствие краха,
а не причина).

### Версия Node и stderr — в отчёте

- `LspDiagnosis.nodeVersion` — версия Node из PATH (`node --version`), читается
  один раз на прогон doctor и печатается в шапке.
- `LspServerDiagnosis.stderrTail` — хвост stderr процесса, который упал. Хвост
  уже копится в `LspConnection.stderrTail`; `LspClient.probe` прикладывает его
  к ошибке (`stderrTail` на объекте ошибки), `probeServer` переносит в диагноз.
  Это закрывает долг `lsp-stderr-in-doctor` в части вывода.
- Doctor печатает до 3 непустых строк stderr под строкой сервера.

### Подсказка установки для `node-too-old`

Вместо повторной установки той же версии — пин совместимой:
`npm i -g typescript-language-server@3.3.2 typescript@5` (3.3.2 — последняя
стабильная 3.x, `engines: >=14.17`). Пин хранится в одном месте
(`node-version.ts`, `OLD_NODE_PINS`) и расширяется по мере надобности.

### `lsp_check` не путает «холодно» и «упало»

`warmWithin` возвращает `{ ok: boolean; error?: string }`:

- `ok: true` — есть тёплое соединение, файл проверяется;
- `ok: false, error` — прогрев отвергся (spawn/initialize); ошибка идёт в
  `health` и в отчёт как `[LSP check failed for <file>: <msg>]`, счётчик
  подряд идущих падений работает как раньше (3 → сервер отключается на сессию);
- `ok: false` без `error` — прогрев ещё идёт: тот же `lsp.check_cold`, что и
  прежде (поведение не меняется, `tests/modules/lsp/check-cold-start.test.ts`
  остаётся зелёным).

Позднее падение (после истечения бюджета) съедается обработчиком промиса, чтобы
не было unhandled rejection; оно будет видно на следующей проверке, потому что
соединения в пуле нет.

## Границы

- Контракт `LspModule`/тулов не меняется: новых тулов и ключей конфига нет.
- Автоматический подбор версии пакета под Node **не** делается: молчаливая
  деградация сервера хуже явной подсказки.
- `findOnPath` (3 с) и пул не трогаются — это отдельные задачи.

## Проверки

| Что | Тест |
|---|---|
| Класс `node-too-old` по краху JS-рантайма, не по обычному таймауту | `tests/modules/lsp/diagnose.test.ts` |
| Doctor отдаёт `nodeVersion`, `stderrTail` и пин-команду | `tests/modules/lsp/diagnose.test.ts` |
| `probe` прикладывает stderr упавшего сервера к ошибке | `tests/modules/lsp/probe-stderr.test.ts` |
| Падение прогрева → `[LSP check failed]`, а не «ещё запускается» | `tests/modules/lsp/check-warmup-failure.test.ts` |
| Отрисовка doctor: версия Node, хвост stderr, пин | `tests/modules/lsp/doctor-render.test.ts` |
| Чтение/разбор версии Node | `tests/modules/lsp/node-version.test.ts` |
| Паритет i18n-ключей | `tests/i18n.test.ts` |
