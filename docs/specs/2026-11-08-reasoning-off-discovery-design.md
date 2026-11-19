# Discovery механизма reasoning для локальных бэкендов

_Дата: 2026-11-08. Ветка: `fix/reasoning-off-discovery`._
_Продолжение [reasoning-strategy](./2026-10-15-reasoning-strategy-design.md) (INV-R1…R5)._

## 1. Дефект

`mode: "none"` не выключает reasoning на llama.cpp. Пресет `openai-compat`
объявляет `prompt-tag` (`src/modules/providers/presets.ts`), поэтому выключение
выражается только тегом `/no_think`; `"none"` в тело не уходит
(`normalizeReasoningEffort` требует `reasoningOff && openai-effort`). Модель тег
игнорирует — reasoning продолжается. Живой замер на llama.cpp/qwen3.8-27b:

| запрос | reasoning, символов |
|---|---|
| без сигнала | 1265 |
| `chat_template_kwargs.enable_thinking=false` | 0 |
| `reasoning_effort: "none"` | 0 |
| `reasoning_effort: "low"` | 256 |
| `reasoning_effort: "high"` | HTTP 500 (шаблон принимает `xhigh/medium/low`) |

Эндпоинт сам сообщает механизм в `/props.chat_template_caps`:

```json
{ "supports_reasoning_effort": true,
  "reasoning_effort_levels": ["low", "medium", "xhigh"] }
```

## 2. Контракт

**INV-R6. Discovery механизма — данные, а не пресет.**
Локальный бэкенд сообщает механизм нативно: lm studio — `/api/v1/models`
(`reasoning.allowed_options ∋ off`), llama.cpp — `/props`
(`chat_template_caps.supports_reasoning_effort`,
`reasoning_effort_levels`; фолбэк — `enable_thinking` в `chat_template` →
`template-kwarg`). Данные пробы кладутся в `ModelCapabilities` и попадают в
экземпляр провайдера тем же трёхслойным резолвом, что `vision`/`tools` (INV-R2).

**INV-R7. Уровни харнесса проецируются на объявленные.**
`reasoningLevels?: string[]` в `ModelCapabilities`. Если список объявлен,
канонический уровень проецируется на ближайший поддерживаемый (не ниже
запрошенного, иначе — высший): `high`/`max` → `xhigh` у llama.cpp. Без списка
действует прежняя нормализация (`max` → `high`). `none` уходит только при
`reasoningOff && openai-effort`; strict-эндпоинты по-прежнему его не получают.

**INV-R8. Пресет не перетирает discovery.** `reasoningLevels` идёт через
`resolveModelCapabilities` (override → probe → preset) и `ProviderManager`
передаёт его в экземпляр вместе со стратегией и `reasoningOff`. Пересборка
провайдера (`reconfigure`, hot-swap, раннер веб-сессии) получает ту же пробу
через `AgentDeps.capabilitiesProbeRef`; иначе экземпляр откатывается к пресету
и `none` снова превращается в `/no_think` без `reasoning_effort`.

## 3. Границы

- Generic `openai-compat` остаётся `prompt-tag`: новое поведение включается
  только ответом конкретного бэкенда на native-пробу.
- Хостед-эндпоинты (`opencode-go`/deepseek) без `/props` не покрыты — остаётся
  долг `hosted-reasoning-discovery` (эмпирика: послать `none`, 400 → strict).
- Честное предупреждение «выключить нечем» для оставшихся бэкендов — вне волны.

## 4. Гварды

- `tests/llm/reasoning-discovery-llamacpp.test.ts` — `/props` с caps →
  `openai-effort` + `reasoningOff` + уровни; без caps → `prompt-tag`; только
  `enable_thinking` в шаблоне → `template-kwarg`; `/props` недоступен → `null`.
- `tests/openai-compat-reasoning.test.ts` — `high`/`max` → `xhigh` при
  объявленных уровнях; `none` → `none`; strict-OpenAI не получает `none`.
- `tests/core/reasoning-strategy-resolve.test.ts` — трёхслойный мердж
  `reasoningLevels`.
- `tests/core/agent-reconfigure-probe.test.ts` — `reconfigure` с
  `capabilitiesProbeRef` собирает провайдера с discovery-стратегией и уровнями,
  а не с пресетом.
- Живой прогон: `none` → 0 символов reasoning, `high` → не 500.
