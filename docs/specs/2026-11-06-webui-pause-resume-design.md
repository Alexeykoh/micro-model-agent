# Пауза/возобновление хода агента в `mma web`

> TODO §1.13 «Пауза агента с возобновлением по кнопке». Правка меняет контракт
> петли (новая фаза ожидания между итерациями) и контракт SSE `state` (новое
> поле) — поэтому спека до кода (правило 2 AGENTS).

## 1. Что правильно и чего эта фича НЕ делает

**Пауза** — приостановка цикла хода на границе итераций: текущая итерация
(LLM-стрим и батч тулов) доходит до конца целиком, следующий вызов модели не
начинается, пока ход не возобновлён. Контекст хода, история, план — целы;
возобновление продолжает **тот же ход**, без нового пользовательского сообщения.

**Это не durable-interrupt.** Пауза живёт в памяти процесса: рестарт сервера её
теряет (ход тогда завершается как прерванный — обычным путём abort).
Сквозное возобновление после краша — отдельный пункт дорожной карты
(`P1 · HITL + kill-switch`, durable `interrupt()`), в эту правку не входит.

Отличие от существующего **Stop** (`POST /api/interrupt` → `agent.shutdown()`):
stop abortит ход (тул-вызовы обрываются, `turn_end.interrupted`), пауза —
удерживает ход между итерациями и позволяет продолжить.

## 2. Инварианты

- **INV-P1** — пауза вступает в силу только на границе итераций
  (`executeAgentLoop`, начало тела `while`). Ни LLM-стрим, ни исполнение
  батча тулов не разрезаются.
- **INV-P2** — `resume()` продолжает тот же ход: никаких новых сообщений в
  историю, `state.iteration` не сброшен, гейты хода (hallucination → critic →
  audit) проходят штатно на финализации.
- **INV-P3** — ожидание паузы обязано сниматься shutdown-ом: `abort`/стоп
  процесса не может зависнуть на паузе. Гейт после ожидания перечитывает
  `isShutdownRequested()` и выходит из цикла.
- **INV-P4** — флаг паузы не течёт за границу хода: `runTurn` сбрасывает его
  на старте (как `shutdownRequested`) и в финализации прогона (остаточная
  пауза после последней итерации не должна подсвечивать кнопку).
- **INV-P5** — UI честный: кнопка паузы доступна только пока ход своей
  сессии бежит (проект `pausedIds` в SSE `state`); `POST /api/pause` на
  не-бегущей сессии — `409 idle` (тот же контракт, что у `/api/interrupt`).

## 3. Реализация

### Ядро (`src/core/`)

`Agent` (флаги-соседи `shutdownRequested`):

- поля `pauseRequested: boolean`, `pauseResolve: (() => void) | null`;
- методы `pause()`, `resume()`, `isPaused()`; `resume()` снимает флаг и
  резолвит ждущий гейт;
- `waitWhilePaused(): Promise<void>` — no-op, если флаг снят; иначе одно
  обещание на гейт (агент не reentrant, Expectation: один цикл на ход).

`agent.ts shutdown()` — в `requestShutdown` резолвить `pauseResolve` (INV-P3).
`agent/turn-run.ts runTurn()` — сброс флага на старте и после прогона (INV-P4).
`agent/loop-run.ts` — в теле `while` перед прологом итерации:

```ts
await ctx.waitWhilePaused();
if (ctx.isShutdownRequested()) break;
```

`LoopRunCtx` получает `waitWhilePaused(): Promise<void>`; `hostView`/хосты —
проводку вида (INV-23, фазы не лезут в `Agent` напрямую).

### Веб-сервер (`src/modules/webui/`)

- `POST /api/pause {sessionId?, action:"pause"|"resume"}` — в
  `chat/actions-api.ts` рядом с `/api/interrupt`; без `sessionId` — все
  бегущие слоты (как stop). Слот не занят → `409 idle`; resume раннеру без
  паузы → `200` идемпотентно (гонка с нажатием).
- `RunPool.pausedIds()` — сессии с `runner.agent.isPaused()`; поле `pausedIds`
  в `sessionStatus()` → попадает в SSE `state` и `GET /api/state`.
- `interruptSlot` (stop) дополнительно снимает паузу, чтобы `409`-гонка
  «pause+stop» не оставляла висящий waiter (перестраховка, INV-P3).

### Клиент (`src/modules/webui/assets/js/`)

- Новый лист `session/pause.ts`: кнопка `#pauseBtn` в композере, непосредственно
  перед `#sendBtn` (стоп/отправка — управление ходом ищут у края поля ввода),
  иконочный вид как у send-кнопки: `pause`/`play` (таблица `icons.ts`), подпись
  в `title`/`aria-label` (`web.pause.*`), клик → `POST /api/pause`;
  состояние рисует из `session.runningSessionIds` + `session.pausedIds`.
- Поле `pausedIds: string[]` в `core/store/session.ts`; заполняет `state-sync.ts`
  из события `state`.
- Вызовы отрисовки: `refreshPauseButton()` из `renderTabstrip` (переключение
  вкладок/статусы) и из `renderActiveState` (каждый полный `state`).
  `composer.ts` (300 строк, лимит правила 6) не правим.

### Тесты (падают без правки)

- `tests/core/agent-pause.test.ts` — пауза на границе итераций: поставлен на
  1-й итерации → второго LLM-вызова нет; `resume()` → ход завершается тем же
  прогоном; `shutdown()` во время паузы не зависает (INV-P3); следующий ход
  не наследует паузу (INV-P4).
- `tests/webui-pause.test.ts` — REST: 409 idle; pause бегущего слота +
  `pausedIds` в broadcast `state`; resume; `action`-валидация 400.
- `tests/webui-pause-dom.test.ts` — DOM: видимость кнопки по running/paused,
  клик шлёт правильный `action`.

## 4. Acceptance

`bun test tests/core/agent-pause.test.ts tests/webui-pause.test.ts
tests/webui-pause-dom.test.ts` зелёные; `bun run quality` зелёный; живой прогон
(`mma web`, длинный ход) — пауза удерживает между итерациями, кнопка
возобновляет тот же ход (по явной команде пользователя).
