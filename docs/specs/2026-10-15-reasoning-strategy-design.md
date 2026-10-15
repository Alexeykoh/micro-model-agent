# Стратегия reasoning — одна точка назначения (W3)

_Дата: 2026-10-15. Ветка: `feat/reasoning-strategy-single-source`._
_Волна W3 плана [2026-10-15-harness-bug-detection-plan.md](../plans/2026-10-15-harness-bug-detection-plan.md)._
_Долг `reasoning-hard-switch` (`docs/agents/debt.md`) оплачен этой волной и снят._

## 1. Что не так (текущее состояние, с адресами)

1. **Стратегия едет через каждый вызов, а не живёт в провайдере.**
   `ChatOptions.reasoningStrategy` (`src/llm/provider.ts:74`) — обычная опция;
   `buildRequestBody` при отсутствии берёт дефолт `"openai-effort"`
   (`src/llm/openai-compat.ts:135`). Call-site обязан её прокинуть и **может забыть**
   (`src/core/agent/loop-llm.ts:116`, `src/core/agent/prompt-phase.ts:154`,
   `src/core/prompt-overflow.ts:218,239`, `src/core/agent/reasoning-resolver.ts:47`).
   Забыл — молча `openai-effort`, даже если провайдер его не принимает.

2. **Резолв стратегии однослойный и расходится с резолвом capabilities.**
   `reasoningStrategyForProvider` читает **только пресет** `BUILTIN_PROVIDERS[type]
   .capabilities.reasoningStrategy` (`src/modules/providers/manager.ts:257-262`).
   `vision`/`tools` резолвятся трёхслойно (`resolveModelCapabilities`: override → probe →
   пресет, `src/modules/providers/capabilities.ts:33`). Два разных ответа на вопрос
   «что эта модель/эндпоинт умеет» — второй источник правды.

3. **Проба не измеряет `openai-effort` и меряет один ординал.**
   `probeReasoningSupport` возвращает `true` для `openai-effort` **до** сетевого вызова
   (`src/modules/reasoning/probe.ts:46`) — «пробуется» превращается в «предполагается».
   Для остальных стратегий меряется единственный признак — «пришёл ли
   `reasoning`-чанк вопреки `"none"`» (`:49-58`).

4. **Нормализация `"none"` глобальна.**
   `normalizeReasoningEffort` выкидывает `"none"` для **всех** стратегий
   (`src/llm/openai-compat.ts:99-103`). Но llama.cpp документирует
   `reasoning_effort: "none"` как **выключатель** — то есть для `openai-effort`
   hard-switch недостижим by construction; для strict OpenAI наоборот: `"none"` даёт HTTP 400.

5. **Статические пресеты `prompt-tag`.** `openai-compat` и `lmstudio` объявлены
   `prompt-tag` (`src/modules/providers/presets.ts:37,69`), хотя `/no_think` у Qwen3 —
   soft switch (см. долг). Для эндпоинтов, документирующих `chat_template_kwargs` или
   `reasoning_effort: "none"`, верный фолбэк — `template-kwarg`/`openai-effort`.

## 2. Целевой контракт (нормативно)

**INV-R1. Стратегия — свойство экземпляра провайдера, не опция вызова.**
Провайдер резолвит `reasoningStrategy` **один раз при сборке** (`createProvider`)
и применяет ко всем `chat()`. `ChatOptions` уровня не несёт стратегию; call-site её не
знает и не может забыть. Новый LLM-вызов без стратегии невозможен по построению: у
экземпляра она есть всегда (может быть `"none"`).

**INV-R2. Один резолвер на capabilities и стратегию.**
`reasoningStrategy` резолвится **тем же трёхслойным** приоритетом, что `vision`/`tools`:
явный конфиг-оверрайд модели → живая проба/дискавери эндпоинта → пресет провайдера.
`resolveModelCapabilities` возвращает и `vision`/`tools`, и `reasoningStrategy`.
Второго источника правды по «что умеет модель» нет.

**INV-R3. Проба даёт два независимых ординала и «не подтверждено».**
Механизм считается поддержанным только при согласии двух признаков: (а) уровень
подавления (`reasoning`-чанк не появился вопреки `"none"`); (б) признак против
офлайн-эталона. Расхождение → диагностика и «не подтверждено» (эквивалент
`probePassed: false`), а не тихое «поддерживается». `openai-effort` **пробуется**
сетевым вызовом, а не проходит по короткому пути.

**INV-R4. Нормализация `"none"` зависит от стратегии.**

| Стратегия | Как выражается выключение | Что уходит в тело |
|---|---|---|
| `openai-effort` | `reasoning_effort: "none"` (llama.cpp, vLLM) | `reasoning_effort: "none"` |
| `template-kwarg` | `chat_template_kwargs.enable_thinking = false` | kwarg, `reasoning_effort` не шлём |
| `prompt-tag` | тег `/no_think` в сообщении (+ effort, если API понимает) | тег; `reasoning_effort` без `"none"` |
| `none` | механизм не применяется | ничего |

`"none"` **не** выкидывается глобально: для `openai-effort` он отправляется.
Значения `"default"`/`undefined` по-прежнему не шлются. `"max"` клампится к `"high"`
для стратегий, пишущих `reasoning_effort`.

**INV-R5. Вызов без стратегии — дефект, видимый гейтом.**
Статический гейт запрещает `reasoningStrategy` в `ChatOptions` и в call-site; рантайм-тест
проверяет, что каждый вызов несёт стратегию из экземпляра.

## 3. Проекция на план

| Шаг | Что делает | Где |
|---|---|---|
| W3.1 | стратегия в экземпляре провайдера; `ChatOptions.reasoningStrategy` удалён | `openai-compat.ts`, `provider.ts`, `create.ts`, call-site |
| W3.2/D1 | `resolveModelCapabilities` возвращает `reasoningStrategy` (3 слоя) | `capabilities.ts`, `manager.ts`, bootstrap |
| W3.2/D2 | проба: два ординала вместо короткого пути | `reasoning/probe.ts` |
| W3.3 | `"none"` стратегии-зависима | `openai-compat.ts` |
| W3.4 | `recording-provider` + таблица call-site | `tests/helpers/*`, call-site |

## 4. Гварды

- `tests/arch/llm-call-options.test.ts` — статически: `ChatOptions` не содержит
  `reasoningStrategy`; ни один call-site не передаёт её; стратегия читается в
  `buildRequestBody` из экземпляра.
- `tests/core/reasoning-strategy-resolve.test.ts` — трёхслойный приоритет
  (override бьёт пробу, проба бьёт пресет), как для vision/tools.
- `tests/core/reasoning-probe-ordinals.test.ts` — согласие ординалов → поддержано,
  расхождение → не подтверждено, `openai-effort` доходит до сетевого вызова.
- `tests/llm/reasoning-none.test.ts` — таблица INV-R4: `"none"` уходит только для
  `openai-effort`, не уходит у strict/`prompt-tag`; `"max"` клампится.
- Позитивные контроли в каждом гейте (иначе проверка вакууозна).

## 5. Границы и риски

- **Живая модель.** D2-проба меняет поведение на реальном эндпоинте; критерий «красный
  на фикстуре» проверяется офлайн (fake-провайдер), но подтверждение на живой модели —
  обязанность релизного прогона. Спека фиксирует, что **без живого прогона D2 не
  считается закрытым**.
- **Hot-swap.** `Agent.setProvider`/`reconfigure` пересобирают экземпляр → новая
  стратегия. Инвариант сохраняется без отдельной синхронизации.
- **Что НЕ меняется.** Форма `ChatOptions` для `maxTokens`/`sessionId`; политика уровня
  (resolver) — она про уровень, а не про механизм; текст `/no_think`.
- **Долг `reasoning-hard-switch` снят**: W3.1–W3.3 + живой прогон на LM Studio/Qwen3 (`none` →
  0 символов reasoning, `high` → 676; проба двух ординалов = `true`).

## 6. Решения

- D-R1: стратегию несёт **экземпляр** провайдера (INV-R1), а не `deps`/call-site.
- D-R2: `reasoningStrategy` живёт в `resolveModelCapabilities` (INV-R2) — один резолвер.
- D-R3: `"none"` — стратегии-зависим (INV-R4); строгая таблица вместо глобального выреза.
- D-R4: проба `openai-effort` перестаёт быть тождественно-`true` (INV-R3).
