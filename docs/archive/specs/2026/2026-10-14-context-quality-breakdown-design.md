# Качество контекста: разбор состава в вебе

Дата: 2026-10-14
Статус: approved
Ветка: `feat/webui-quality-breakdown`

## 1. Проблема и цель

В панели `session · usage` у веб-сайдбара есть строка «качество» — число
`contextQuality` (0..100), которое `ContextManager.getQuality()` считает из
четырёх факторов (нагрузка контекста, компакции, плотность ошибок, свежесть).
Пользователь видит одно число и **не понимает, из чего оно сложилось**: упало
качество — непонятно, это переполнение, компакции или ошибки.

**Цель:** показать состав оценки — при наведении/клике на строку «качество»
всплывает разбор: каждая составляющая, её нормированный фактор и вес, и сколько
итоговых пунктов она даёт.

## 2. Non-goals

- Не меняем формулу `getQuality()` и порог форсированной компакции — только
  выносим уже существующие слагаемые наружу.
- Не трогаем терминальный рендер (`context-renderer.ts`) — он печатает число.
  (Расширить можно отдельно.)
- Не добавляем новых ключей конфига.

## 3. Модель данных

`ContextManager` получает приватный `qualityFactors()` и публичный
`getQualityBreakdown()`; `getQuality()` считается из тех же факторов (единый
источник правды — расхождение числа и разбора невозможно).

```ts
// src/core/types.ts
export interface ContextQualityPart {
  /** Составляющая: нагрузка / компакции / ошибки / свежесть. */
  key: "load" | "compaction" | "errors" | "freshness";
  /** Нормированный фактор 0..1 (больше — лучше). */
  factor: number;
  /** Вес фактора в итоговой оценке (сумма весов = 1). */
  weight: number;
}
export interface ContextQualityBreakdown {
  /** Итог 0..100 (равен getQuality()). */
  total: number;
  parts: ContextQualityPart[];
}
```

Веса — 0.4 (нагрузка) / 0.25 (компакции) / 0.2 (ошибки) / 0.15 (свежесть),
как в текущей формуле.

## 4. Путь данных (аддитивно, все поля опциональны)

`ContextSnapshot.qualityBreakdown` → `getSnapshot()` →
`LiveContextSource`/`liveContextUsage` (живой бродкаст во время хода) и
`AgentResult.contextQualityBreakdown` (`loop-result.ts`, обе ветки) →
`captureUsage` → `UsageSnapshot.contextQualityBreakdown` →
`HostStateSnapshot.contextQualityBreakdown` → SSE `state`/`usage` → фронтенд.

Старые консьюмеры (REPL/serve) поле игнорируют. Per-session персист
(`web-usage.json`) сохраняет его автоматически (сериализуется весь снимок).

## 5. Фронтенд

`feed/sidebar.ts` `renderUsage`: у строки «качество» появляется тултип
(`attachTooltip` из `dom.js`) со списком составляющих: локализованное имя ·
фактор в % · вес · вклад в итог. Строка качества сегмента полосы — вне скоупа.

Ключи i18n (en+ru): `web.usage.quality_load`, `web.usage.quality_compaction`,
`web.usage.quality_errors`, `web.usage.quality_freshness`,
`web.usage.quality_part` («{value}% · вес {weight}% → {score} п.»),
`web.usage.quality_title`.

## 6. Приёмка

- `tests/context-quality-breakdown.test.ts`: `getQualityBreakdown().total ===
  getQuality()` на разных состояниях; сумма весов = 1; факторы 0..1.
- `tests/host-state` (или существующий) — `captureUsage`/`liveContextUsage`
  проносят поле.
- en/ru паритет; `bun test` + `bun run quality` зелёные; `CHANGELOG.md`.
