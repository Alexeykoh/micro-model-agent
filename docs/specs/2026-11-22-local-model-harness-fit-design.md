# MMA —适配 харнесса под локальные квантованные модели (0.26.1)

**Дата:** 2026-11-22 · **Ветка:** `integration/v0.26.1-live`
**Статус:** target (нормативный контракт)
**Источник:** живые прогоны `ses_mwqthf85…` (qwen3.8-27b, llama.cpp) и
`ses_mwqraq84…` (hy4-flash-free, opencode-go) + разбор externally documented practice
(Qwen3 hybrid thinking, llama.cpp issues #13160/#13427, OpenCode permissions).

Модель **не правится** — только харнесс, конфиг и диагностика.

## 1. Проблема

1. **Reasoning-переговоры с провайдером.** В fixed-режиме `reasoning.mode=minimal`
   резолвер берёт уровень как есть и игнорирует `probePassed` и объявленные
   `reasoningLevels`. Для llama.cpp (`prompt-tag → mechanism IGNORED`) это даёт
   `reasoning:"minimal"` в запросе и «LLM request failed after retries». В auto-режиме
   кламп на levels есть — в fixed его нет.
2. **Политика shell-команд.** Статический `dangerousOperators` (`>`, `|`, `&&`, `;`) и
   blacklist (`node`, `curl`, `powershell`…) блокируют mundane-команды без механизма
   «подтвердить / разрешить всегда». Маленькая модель не может осмыслить generic
   `[SECURITY BLOCKED]` и повторяет запрещённую форму, сжигая ходы. В opencode дефолт —
   `allow` для всего, `ask`/`deny` только по явным правилам (last-match-wins).
3. **Tool-call parsing и sampler-пресеты.** Практика локальных Qwen: 80% отказов tool
   call — харнесс (отсутствует per-model parser), а не модель; non-thinking требует
   других sampler-настроек (temp 0.7 / top_p 0.8), чем thinking (0.6 / 0.95); кривой
   chat-template кванта ломает переключение режимов; KV-cache precision даёт галлюцинации.
   Харнесс сейчас молча списывает эти отказы на модель.

## 2. Инварианты

| ID | Инвариант | Гейт |
|----|-----------|------|
| **LM-1** | В **fixed** reasoning-режиме уровень клампится так же, как в auto: если проба не прошла (`mechanism IGNORED`) или провайдер не объявил granular-уровни — в запрос **не уходит** `reasoning`/`reasoningEffort` (`level: undefined`). | `tests/core/reasoning-fixed-negotiation.test.ts` |
| **LM-2** | Отказ провайдера на `reasoning`-параметр фиксируется fail-open диагностикой с причиной; повтор того же уровня в этом ходе не производится. | `tests/core/reasoning-fixed-negotiation.test.ts` |
| **LM-3** | При `execution.profile === "local-trusted"` и отсутствии явного `security.bash.dangerousOperators` действует **разрешительная** bash-политика: обычные shell-операторы (`>`, `>>`, `2>`, `\|`, `&&`, `\|\|`, `;`) разрешены; hard-deny остаётся только за реально деструктивными командами/флагами. `sandbox` и явная конфигурация не меняются. | `tests/core/local-trusted-bash-policy.test.ts` |
| **LM-4** | Повторяющийся отказ разбора tool call на локальной модели даёт диагностику с actionable-советом (per-model parser, `--chat-template-kwargs`, KV-cache, quant ≥ Q4), а не молча «модель тупит». | `tests/core/toolcall-parser-diagnostic.test.ts` |
| **LM-5** | Deployment-настройки (non-thinking на сервере, llama-swap варианты, samplers, `-ctk q8_0`, tool-call parser) описаны в `docs/agents/local-models.md` как рекомендация, без изменения модели. | `tests/docs-link-check.test.ts` |

## 3. Contracts and flows

### LM-1/2 — переговоры reasoning
`ReasoningEffortResolver.resolve()` расширяется: общий хелпер
`negotiateLevel(requested, probePassed, declaredLevels)` применяется и к `auto`, и к `fixed`.
Если `probePassed === false` либо `declaredLevels.length === 0` → `undefined`.
Деградация пишется в session-log событием `reasoning_degraded` (добавить в
`DIAGNOSTIC_EVENTS`) с `cause: "mechanism ignored"` / `"no granular levels"`.

### LM-3 — политика shell
`mergeSecurityConfig(userConfig, executionProfile?)`: если профиль `local-trusted`
и `userConfig?.bash?.dangerousOperators === undefined`, подставлять
`PERMISSIVE_DANGEROUS_OPERATORS = []` из пресета, а blacklist — `PERMISSIVE_BASH_BLACKLIST`.
Вызывающий (`config/load`) передаёт профиль. Sandbox и явная конфигурация сохраняют
текущее поведение 1:1.

### LM-4 — диагностика parser
Чистый хелпер `toolcallParserHint(profile: {model, providerType, failures}): string|undefined`
в `src/modules/recovery/`; срабатывает после ≥3 отказов разбора подряд и возвращает
строку-совет. Пишется fail-open диагностикой `tool_degraded` + в `<system-summary>`.

## 4. Что не делается

- Правка весов/кванта/шаблона модели, choice forced tool_choice, снятие всех ограничений
  безопасности, изменение `CHANGELOG.md`/версии.

## 5. Волны

1. LM-1/2 — reasoning negotiation + diagnostic.
2. LM-3 — local-trusted bash policy.
3. LM-4/5 — parser diagnostic + docs/agents/local-models.md.
