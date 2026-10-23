# Честный статус reasoning и индикатор фактической ступени

_Дата: 2026-10-23. Ветка: `fix/reasoning-status-honesty`._
_Связано: [reasoning-strategy](./2026-10-15-reasoning-strategy-design.md) (INV-R1…R5),
[dynamic-reasoning-control](./2026-08-25-dynamic-reasoning-control.ru.md),
долг `hosted-reasoning-discovery` ([debt.md](../agents/debt.md))._

## 1. Что не так

1. **Вердикт пробы подменяет собой факт.** Веб-селектор рисует
   «выкл (бэкенд игнорирует)» (`web.selectors.reasoning_off`), когда
   `ReasoningView.supported === false`. Это вердикт одноразовой фоновой пробы
   (`probeReasoningSupport`), а не наблюдение об уровне. Проба меряет ответ на
   `Reply with exactly: ok`: модель вправе не рассуждать на тривиальном
   промпте — и тогда «не подтвердили» превращается в утверждение «бэкенд
   игнорирует».
2. **Кэш не различает механизм.** Ключ кэша — `baseUrl|model`
   (`probe.ts:cacheKey`). На LM Studio механизм зависит от нативного discovery
   (`/api/v1/models` → `reasoning.allowed_options ∋ off`): успел он за 3 с или
   нет — стратегия `prompt-tag` или `openai-effort` (`reasoningOff`). Один и
   тот же `false` переиспользуется для другой механики, поэтому вердикт «то
   есть, то нет».
3. **Отрицательный вердикт живёт 24 ч.** `REASONING_CACHE_TTL_MS` один для
   `true` и `false`; при чтении с диска в память пишется `ts: Date.now()`,
   то есть TTL ещё и продлевается.
4. **UI и агент резолвят стратегию по-разному.** `buildReasoningView` читает
   только пресет, агент — трёхслойно (`override → probe → preset`, INV-R2).
   UI может говорить о `prompt-tag`, пока агент применяет `openai-effort`.
5. **Фактическая ступень нигде не видна.** `ReasoningEffortResolver.resolve`
   вычисляет `level/strategy/source`, но результат остаётся локальным в
   `runLlmPhase` и уходит только в `session.jsonl` (`reasoning_control`).
   `Agent.reasoningLevel` — состояние override (`set_thinking`), а не
   эффективный уровень итерации. Пользователь не видит, что применилось.

## 2. Контракт (нормативно)

**INV-R6. Проба — про механизм, а не про интеллект модели.**
Кэш пробы привязан к паре «эндпоинт+модель+стратегия+наличие off-switch».
Отрицательный вердикт живёт короче положительного и не продлевается чтением
с диска. Проба «включено» использует промпт, который провоцирует рассуждение
(многошаговый вопрос); тривиальный `Reply with exactly: ok` запрещён.

**INV-R7. Не подтверждено ≠ игнорируется.**
UI не утверждает «бэкенд игнорирует». `supported === false` отображается как
«авто-политика не подтверждена (проба)»; меню уровней остаётся доступным,
потому что фиксированные уровни могут работать даже там, где проба не смогла
подтвердить off-переключатель.

**INV-R8. UI показывает тот же механизм, что применяет агент.**
Bootstrap запоминает фактически резолвнутый механизм (`strategy` +
`reasoningOff`) для пары эндпоинт+модель (`probe.ts`), и `ReasoningView`
читает его; пока агент не резолвил — фолбэк на пресет. Второй резолвер в UI
не появляется.

**INV-R9. Эффективная ступень итерации наблюдаема.**
Решение резолвера (`level`, `strategy`, `source`) едет вместе с фазой
`thinking` (`OnPhase(phase, info)`) и доступно ДО старта генерации.
Поверхности показывают его явно:
- Web: SSE `reasoning` несёт аддитивные поля `level`/`source`; заголовок
  блока «Думаю» показывает фактический уровень.
- REPL/one-shot: строка статуса (спиннер) показывает фактический уровень; при
  `level === undefined` — `default` (решает бэкенд).
Смена уровня политикой видна на следующей итерации без перезапуска.

## 3. Проекция на код

| Шаг | Что делает | Где |
|---|---|---|
| R1 | `cacheKey(baseUrl, model, strategy, reasoningOff)`; старое поведение не читается (ключ другой) | `modules/reasoning/probe.ts` |
| R2 | позитивный/негативный TTL; `ts` из диска не подменяется | `probe.ts`, `config/timeouts.ts` |
| R3 | промпт пробы с многошаговым вопросом | `probe.ts` |
| R4 | `probeReasoningSupportCached` — единая точка «механизм + кэш» | `modules/reasoning/probe.ts` |
| R5 | `buildReasoningView(config)` берёт механизм, резолвнутый агентом, иначе пресет; ключ кэша общий | `webui/settings/reasoning-view.ts` |
| R6 | механизм запоминается при bootstrap — без проброса capabilities по вебу | `core/bootstrap/provider-phase.ts` |
| R7 | `supported === false` → «не подтверждено», уровни остаются | `webui/assets/js/settings/write.ts`, i18n |
| R8 | `OnPhase(phase, info)` + `ReasoningPhaseInfo` вместо хранения в Agent | `core/types.ts`, `core/agent/loop-llm.ts`, `core/agent/turn-output.ts` |
| R9 | Web: `reasoning` SSE + метка в заголовке блока | `webui/session/forward.ts`, `webui/session/run-agent.ts`, `webui/assets/js/feed/*`, i18n |
| R10 | REPL/one-shot: уровень в спиннере | `ui/renderer.ts`, `cli/repl.ts`, `cli/main.ts` |

## 4. Гварды

- `tests/modules/reasoning/probe.test.ts` — ключ различает стратегию и
  off-switch; негативный TTL короче; проба не шлёт тривиальный промпт.
- `tests/webui-reasoning-view.test.ts` — запомненный агентом механизм меняет
  стратегию вида (INV-R8); ключ кэша совпадает с пробой.
- `tests/core/agent-reasoning-override.test.ts` — эффективный уровень уходит в
  `onPhase("thinking", info)`; при `auto` без пробы — `undefined` (`default`);
  `set_thinking` виден как `agent_override`.
- `tests/ui/renderer.test.ts` — спиннер содержит фактический уровень;
  `default` показывается явно.
- `tests/webui-reasoning-status.test.ts` — `supported: false` даёт
  «не подтверждено», а не «игнорирует»; набор уровней непуст.
- `tests/webui-forward.test.ts` + `tests/webui-feed-lifecycle-dom.test.ts` —
  SSE `reasoning` несёт `level`/`source`, заголовок блока «Думаю» показывает
  уровень.

## 5. Границы и риски

- **Стоимость пробы.** Промпт длиннее, но `maxTokens` прежний (512): двух
  вызовов раз в TTL достаточно, чтобы увидеть reasoning-чанк. Кэш — тот же
  файл, что и раньше.
- **Не все бэкенды стримят reasoning отдельным каналом.** Тогда «включено»
  не подтверждается — это честное `false` («не подтверждено»), а не поломка.
- **Hot-swap.** Механизм перезаписывается при следующем bootstrap/пробе для
  новой пары; ключ кэша включает стратегию, поэтому старый вердикт не
  переиспользуется.
- **SSE-совместимость.** Поля `level`/`source` аддитивны; клиенты, которые их
  не знают, продолжают работать.
- **Долг `hosted-reasoning-discovery` не закрывается**: эмпирическое
  определение off-switch у хостед-эндпоинтов остаётся отдельной задачей.
