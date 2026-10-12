/**
 * Эффекты записи ключа конфига (INV-18): **декларация последствий**, а не флаг
 * «нужна пересборка». Ключ говорит, что именно меняется в живом рантайме; кто
 * применяет — решает поверхность через общий апплер (см. W3-спеку §3).
 *
 * Вынесено в отдельный модуль, чтобы `registry.ts` и `registry-extra.ts` могли
 * импортировать без цикла.
 */

/** Последствие записи ключа. */
export type ConfigEffect =
  | "provider.rebuild" // пересобрать активного провайдера + costTracker
  | "context.resize" // resize ContextManager (окно/бюджеты/tokenCounter)
  | "reasoning.reload" // пересчитать reasoning strategy активного провайдера
  | "session.meta" // обновить meta сессии (окно/модель)
  | "i18n.reload" // перечитать локаль
  | "plugins.gate" // применить deny-list к живому PluginManager
  | "tools.reload"; // пересобрать видимый набор тулов

/**
 * Полная пересборка агента — дефолт для ключей, которые раньше объявляли
 * `reconfigure: true` (одна композитная операция `Agent.reconfigure`).
 * Порядок: provider → context → reasoning → meta.
 */
export const REBUILD: readonly ConfigEffect[] = [
  "provider.rebuild",
  "context.resize",
  "reasoning.reload",
  "session.meta",
];

/** Эффекты, требующие пересборки живого агента (композитный `Agent.reconfigure`). */
export function needsRebuild(effects: readonly ConfigEffect[] | undefined): boolean {
  if (!effects || effects.length === 0) return false;
  return effects.some(
    (e) =>
      e === "provider.rebuild" ||
      e === "context.resize" ||
      e === "reasoning.reload" ||
      e === "session.meta",
  );
}
