# W3 — `ConfigStore`: один путь записи с объявленными эффектами

**Дата:** 2026-10-13 · **Ветка:** `docs/architecture-v2` (в рамках architecture v2)
**Нормативная база:** [architecture v2](./2026-10-12-architecture-v2-design.md) §1.6,
INV-18…21 · [аудит](../analysis/2026-10-12-harness-module-audit.md) 7.5

**Причина.** `setConfigValue` (`src/config/registry.ts`) возвращает
`reconfigure: boolean`, а что именно пересобирать — решает каждая поверхность
сама (`agent.reconfigure`, веб-хук, CLI). Плюс слой конфига **скрыто мутирует**
чужой домен (`applyProviderModelMemory` правит `provider.entries[]`/`provider.models`,
INV-19). `WebUiState.config` держит ссылку с bootstrap (INV-20). Ключи — ручная
таблица на 156 строк, модуль не может объявить свой ключ (INV-21).

---

## 1. Границы

**Входит:** `ConfigEffect` + `ConfigKeyDef.effects` (замена `reconfigure: boolean`),
`ConfigSetOk.effects`, применение эффектов одним реестром (INV-18); вынос
provider-памяти из слоя конфига (INV-19); снимок конфига с версией (INV-20);
объявление ключей из модуля (INV-21).

**Не входит:** смена семантики конкретных ключей; per-session синглтоны (W1 §4.1);
полная UI-модель ключей (гейт у `PANEL_SECTIONS` — отдельно).

---

## 2. Контракт эффектов (INV-18)

```ts
/** Последствие записи ключа. Декларация, не «флаг пересборки». */
export type ConfigEffect =
  | "provider.rebuild"   // пересобрать активного провайдера + costTracker
  | "context.resize"     // resize ContextManager (окно/бюджеты/tokenCounter)
  | "reasoning.reload"   // пересчитать reasoning strategy активного провайдера
  | "session.meta"       // обновить meta сессии (окно/модель)
  | "i18n.reload"        // перечитать локаль
  | "plugins.gate"       // применить deny-list к живому PluginManager
  | "tools.reload";      // пересобрать видимый набор тулов

interface ConfigKeyDef {
  // было: reconfigure: boolean
  effects: ConfigEffect[];
  // ...
}

interface ConfigSetOk {
  // было: reconfigure: boolean; reasoningChanged: boolean
  effects: ConfigEffect[];
  // ...
}
```

- **Дефолт-группа.** Ключ, менявший `reconfigure: true` (пересборка агента:
  provider+context+reasoning+session.meta), объявляет
  `REBUILD: ConfigEffect[] = ["provider.rebuild","context.resize","reasoning.reload","session.meta"]`.
  Это сохраняет текущее поведение (поверхность звала один `agent.reconfigure`),
  но теперь последствия **названы** и их можно сузить по ключу.
- **`reasoningChanged`** схлопывается в `"reasoning.reload"` (эффект в списке),
  а не отдельное поле.
- **`plugins.gate`** и **`i18n.reload`** — как и раньше, применяются поверхностью,
  но определяются ключом, а не догадкой вызывающего.

---

## 3. Один применяющий (реестр эффектов)

Эффекты применяет **не** `setConfigValue` (слой конфига не знает про агента), а
`ConfigStore`/поверхность через **реестр хендлеров эффекта**:

```ts
type ConfigEffectApplier = (config: AppConfig, effects: ConfigEffect[]) => Promise<void>;
```

- REPL/CLI/веб регистрируют один апплер: для любого из
  `provider.rebuild/context.resize/reasoning.reload/session.meta` → `agent.reconfigure(config)`
  (одна композитная операция); `i18n.reload` → смена локали; `plugins.gate` →
  уже применён внутри `setConfigValue` (эффект-в-процессе, см. §4).
- Так «что делать» перестаёт быть решением каждой поверхности: она спрашивает
  `result.effects` и отдаёт их общему апплеру.

Реализация шага 1 (W3.1/W3.2) сохраняет текущее поведение 1:1: апплер просто
вызывает существующий `agent.reconfigure` при наличии любого «agent»-эффекта.

---

## 4. Слой конфига не знает чужих доменов (INV-19)

`applyProviderModelMemory` (`provider.models`/`mirrorActiveEntryFields`) **уезжает**
из `config/registry.ts`:

- запись `model`/`provider.active` больше не мутирует `provider.models`/плоские поля
  в слое конфига;
- память моделей провайдера становится **эффектом** инициатора смены провайдера
  (`provider.rebuild` — сам `buildActiveProvider`/менеджер знает про свои entries);
- шаг оформляется отдельным коммитом (W3.3) с тестом на отсутствие мутации
  `provider.entries[]` из `setConfigValue`.

---

## 5. Снимок с версией (INV-20)

`WebUiState.config` перестаёт быть долгоживущей ссылкой на объект конфига:

- конфиг несёт `configVersion` (растёт на каждом `set`/`apply`),
- поверхность читает **снимок** `{ version, config }`; запись с устаревшей версией
  не перезаписывает чужие домены (merge только изменённого ключа, а не всего объекта).

Шаг W3.4; тест: параллельная запись CLI во время открытой вкладки не теряется.

---

## 6. Модульные ключи (INV-21)

`ConfigKeyDef` остаётся, но реестр получает **регистрацию из модуля**:
`ModuleDef.configKeys?(): ConfigKeyDef[]` → `ModuleHost` собирает их и добавляет в
`configDefs()`. `registry-extra.ts` перестаёт быть единственным входом для новых
ключей модулей.

Шаг W3.5; тест: ключ, объявленный модулем, доступен `get/set` и виден в списке.

---

## 7. Задачи

| # | Задача | Проверка |
|---|---|---|
| W3.1 | `ConfigEffect` + `effects` в `ConfigKeyDef`/дефах (замена `reconfigure`) | typecheck + `tests/config-registry*` зелёные |
| W3.2 | `ConfigSetOk.effects`; поверхности применяют через общий апплер | `tests/config*`, REPL/веб-тесты |
| W3.3 | Вынести provider-память из слоя конфига (INV-19) | тест: `setConfigValue("model", …)` не трогает `provider.entries[]` |
| W3.4 | Снимок с версией (INV-20) | тест параллельной записи |
| W3.5 | `ModuleDef.configKeys()` (INV-21) | тест модульного ключа |

## 8. Риски

- **Много call-site `result.reconfigure`.** Замена → `result.effects`; каждую
  поверхность правим точечно, поведение сохраняем (один композитный reconfigure).
- **Порядок эффектов.** `provider.rebuild` до `context.resize` (окно из провайдера),
  как сейчас в `Agent.reconfigure`.
- **Совместимость конфига.** Формат `config.json` не меняется; меняется только форма
  результата `set` и место применения side-effect.
