# Честный `session.jsonl`: что модель видела, а не только что она вызвала

**Дата:** 2026-10-26 · **Ветка:** `feat/session-directive-log`
**Связь:** [видимость хода](./2026-10-26-session-visibility-design.md) §1
(«Не входит»), INV-13 (каждое событие несёт `source`), INV-15,
правило 1 AGENTS.md (измерение «модель»)

---

## 0. Зачем

Разбор живого прогона `ses_mvpfzfg7` вскрыл дыру в наблюдаемости: директива
`narration` **сработала** (итерация 19), но в `session.jsonl` её нет — она
вставлена в контекст как `<system-summary>` и видна только в `app.jsonl` как
строчка `logger.diagnostic`.

Следствия:

- по журналу сессии нельзя восстановить, **что видел агент**: приказ «скажи,
  что делаешь», статус плана, honest-stop, recovery-гайданс — всё это
  отсутствует в артефакте, который читают `mma session show`, webui и я при
  разборе;
- канал `type: "plan"` при этом занят не планами: `stuck-warning`,
  `web-search: empty/failed` пишутся туда же через `logPlan` (в
  `ses_mvpdchvi` все шесть событий `type=plan` — ругань детектора, ни одного
  плана);
- при разборе «почему агент поступил так» приходится склеивать два файла и
  верить, что они про одну итерацию.

Правило 5: правило без проверки живёт до следующего изменения — поэтому здесь
же гейт на канал.

---

## 1. Границы

**Входит:**

- новый тип события `directive` в `session.jsonl`: каждое сообщение харнесса,
  вставленное в контекст как `<system-summary>`, пишется туда;
- событие `directive` для предупреждений execution-модуля (`stuck-warning`,
  `web-search`), которые сейчас маскируются под `plan`;
- канал `plan` остаётся только за жизненным циклом плана (create / re-plan /
  step done / abort).

**Не входит:**

- переписывание формата существующих событий (`assistant`, `tool_call`,
  `tool_result`, `reasoning`);
- показ директив в webui-ленте (фронтенд читает SSE, а не `session.jsonl`);
- логирование **всех** сообщений контекста (tool-результаты и так лежат в
  `tool_result`); только инъекции харнесса.

---

## 2. Контракт

### 2.1. Событие `directive`

```json
{
  "ts": "2026-10-26T16:02:01.190Z",
  "type": "directive",
  "source": "core",
  "tool": "system_summary",
  "content": "<system-summary>Ты не сказал пользователю ни слова…</system-summary>",
  "iteration": 19
}
```

- `content` — **точный** текст сообщения, попавшего в контекст (вместе с
  обёрткой `<system-summary>`): при разборе важно видеть ровно то, что видел
  провайдер.
- `tool` — канал: `system_summary` (директивы харнесса) либо имя события
  execution-модуля (`stuck-warning`, `web-search`).
- `iteration` — итерация хода на момент вставки.

### 2.2. Точка съёма — одна

`ContextManager.addMessage()` уже отличает инъекции харнесса от настоящих
сообщений пользователя (`text.startsWith("<system-summary>")`, используется для
трекинга задачи). Здесь же вызывается опциональный sink:

```ts
setHarnessSink(fn: ((text: string) => void) | null): void
```

Bootstrap/цикл ставит sink один раз на ход: `slog.logDirective("system_summary",
text, state.iteration)`. Ни один вызов `issueDirective` править не нужно —
директива пишется там, где реально попадает в контекст, включая
пере-утверждение после компакции (`reassertStandingDirectives`).

### 2.3. Канал `plan` — только планы

`logPlan(event, …)` получает второго жильца не получает. Предупреждения
execution-модуля уходят в `directive`:

- `execution-plugin.ts` — `stuck-warning` → `sessionLog.directive(...)`;
- `error-search.ts` — `web-search` → `sessionLog.directive(...)`;
- `step-advance.ts` / `plan-actions.ts` — остаются на `plan` (это шаги плана).

`sessionLog` в контексте тулов/плагинов получает метод `directive(event,
detail, iteration?)`; сигнатура `plan` не меняется.

---

## 3. Инвариант (проверка)

`tests/core/session-log-directive.test.ts`:

1. `ContextManager.addMessage({role:"user", content:"<system-summary>…"})` при
   установленном sink → ровно одно событие с точным текстом;
2. обычное сообщение пользователя sink **не** вызывает (иначе журнал утонет в
   сообщениях и `directive` перестанет что-либо значить);
3. `SessionLogger.logDirective("system_summary", text, 19)` пишет
   `type: "directive"` с `tool`/`iteration`;
4. статический гейт: в `src/modules/execution/` нет `sessionLog.plan(` с
   событиями `stuck-warning`/`web-search` (правило «канал не переиспользуют»).

---

## 4. Что это разблокирует

- приёмку по `session.jsonl` вместо `app.jsonl` (сейчас в спеке видимости хода
  это записано как ограничение);
- следующий шаг — стоп по отсутствию **новых фактов**, а не по числу отказов:
  без журнала инъекций нельзя проверить, что директива вообще дошла до модели;
- `mma session show`: видно, что агент получал, а не только что вызывал.

---

## 5. Проверка и приёмка

1. тест из §3 падает до правки;
2. `bun test` + `bun run quality` зелёные;
3. живой прогон: после `--dir <проект>` один короткий ход, который гарантированно
   получает директиву (молчаливые пакеты или stuck), и в `session.jsonl`
   появляется `type: "directive"` с текстом, которого раньше не было.
