# Спека: пробы при смене идентичности провайдера (context + reasoning)

Дата: 2026-11-10 · Ветка: `fix/provider-context-reasoning` · Инварианты: INV-R2, INV-W6, INV-15, INV-R7, INV-R8

## Проблема

Данные провайдера (контекст, capabilities, reasoning) определяются в **bootstrap** и при
переключении провайдера/модели (`reconfigure`, `setProvider`, `/provider use`, веб-свитч)
обновляются **частично**:

1. **Контекст** — `reprobeActiveProvider` гоняет `probeProviderContext`, но сама проба не
   читала `limit.context` (OpenCode Zen/Go) → возврат null → fail-open оставлял окно
   прошлого провайдера. *(Починено волной A в `native-context.ts`.)*
2. **Capabilities** — `probeNativeCapabilities` вызывается **только в bootstrap**
   (`setupProviderPhase`). После свитча `capabilitiesRef.probe` несёт discovery
   **предыдущего** бэкенда, а `resolveModelCapabilities` даёт пробе приоритет над
   пресетом → к новому провайдеру применялись чужие `reasoningStrategy`/`reasoningLevels`/
   `reasoningOff`/`vision`. Хуже, чем отсутствие пробы: нарушает контракт `deps.ts`
   (INV-R2: «пересборка обязана видеть те же discovery-данные, что и bootstrap»).
3. **Результат reasoning-пробы** — `reasoningProbe` и `probePassed` замыкают стартовую
   пару `baseUrl|model`; после свитча auto-политика применяла вердикт чужого бэкенда.
4. **Отображение** — `rememberReasoningMechanism` пишется только в bootstrap и в
   `probeReasoningSupportCached` для стартовой пары → UI (`buildReasoningView`) после
   свитча падал на пресет, расходясь с реально применяемой (чужой) стратегией.

## Решение

Смена идентичности активной записи (`probeIdentityOf`: model + baseUrl + active + type)
— **единственный триггер** обновления всех проб провайдера, независимо от `contextAuto`
(он управляет только окном контекста).

```
reconfigure(config, opts)
 ├─ identityChanged = sameProbeIdentity(lastProbeIdentity, probeIdentityOf(config)) === false
 ├─ opts.probe !== false (основной агент):
 │   ├─ refreshCapabilitiesProbe   ← СЕТЬ: probeNativeCapabilities новой пары;
 │   │                               результат ПЕРЕЗАПИСЫВАЕТ capabilitiesRef.probe
 │   │                               (включая сброс в undefined) — чужие данные
 │   │                               не должны перебивать пресет нового провайдера
 │   ├─ reprobeActiveProvider      ← СЕТЬ: окно контекста (как раньше, INV-W6-кеш)
 │   └─ restartReasoningProbe      ← СЕТЬ ФОНОМ: новая ленивая reasoning-probe для
 │                                   новой пары; до её резолва probePassed = false
 ├─ opts.probe === false (раннеры пула, probe уже сделал основной агент):
 │   └─ invalidateReasoningProbe   ← БЕЗ СЕТИ: probePassed = false, probe → «не
 │                                   подтверждено»; чужой вердикт не применяется
 ├─ buildActiveProvider            ← видит ОБНОВЛЁННЫЙ capabilitiesRef.probe
 ├─ applyReasoningStrategy         ← стратегия/уровни из новой пробы + пресет
 │   + rememberReasoningMechanism  ← UI читает то же, что применяет агент (INV-R8)
 └─ contextManager.resize / setEffectiveContext (как раньше)
```

### Правила

- **INV-R2**: probe capabilities — свойство **идентичности**, а не процесса. Обновляется
  при каждой смене идентичности; при ошибке — сбрасывается в `undefined` (пресет нового
  провайдера), а не остаётся чужим. Ошибка пробы — INV-15-диагностика.
- **`contextAuto: false`** гейтит только контекстную пробу; capabilities обновляются
  всегда (это не окно, а знание о бэкенде).
- **INV-15**: сбой обновления проб не блокирует переключение (fail-open, диагностика).
- **INV-R6/B2**: до резолва новой reasoning-пробы `probePassed = false` — консервативно
  (auto-политика молчит), а не «подтверждено по чужому бэкенду».
- **INV-R8**: `rememberReasoningMechanism` пишется для пары, которой соответствует
  применённая стратегия (bootstrap — стартовой, reconfigure — новой).
- **INV-W6**: контекстная проба продолжает кешироваться по идентичности; `opts.probe:false`
  не запускает сетевых проб вообще.
- **Не кешируется** (осознанно): capabilities/reasoning-пробы — свитч провайдера редок,
  stale-кеш здесь дороже одного запроса.

### Контракты, которые НЕ меняются

- `probeProviderContext` / `probeNativeCapabilities` — их собственные контракты целы
  (волна A лишь научила первую читать `limit.context`).
- `capabilitiesRef` остаётся общим объектом для main/раннеров/субагентов — обновляет
  его только основной агент (`probe: true`). Единственное расширение: в том же боксе
  живёт `reasoningProbe` (геттер ленивой пробы), поэтому раннер, спавненный после
  свитча, читает актуальный вердикт, а не снимок bootstrap (`session-runner-wiring`
  читает бокс; `restartReasoningProbe`/`invalidateReasoningProbe` публикуют в него).
- Порядок фаз `reconfigure` (probe → build → strategy → resize) сохраняется.

## Границы

- **Вне спеки**: empirical-детект off-switch для хостед-эндпоинтов — отдельный долг
  `hosted-reasoning-discovery` (debt.md).
- Раннеры с `probe: false` не ходят в сеть и не обновляют `lastProbeIdentity` — их
  следующий reconfigure с `probe: true` дообыщет пропущенное.

## Проверки (правило 5)

- `tests/core/provider-switch-probes.test.ts` — свитч обновляет capabilities
  (перезапрос → новые данные; офлайн → сброс к пресету), `rememberReasoningMechanism`
  для новой пары, сброс/рестарт `probePassed`, `probe: false` без сети.
- `tests/llm/provider-context-probe.test.ts` — `limit.context` (волна A).
- `tests/providers/*`, `tests/core/agent-reconfigure-probe.test.ts` — регрессия INV-W6/R2.
