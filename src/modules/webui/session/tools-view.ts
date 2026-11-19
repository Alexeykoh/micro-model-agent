/**
 * Состояние панели Tools: базовый tag-набор сессии + ручные on/off.
 * Панель живёт на композере и показывает именно тот набор, который уйдёт в
 * схему LLM следующего хода. Overrides хранятся в `WebUiState` по session id и
 * применяются к раннеру при спавне и сразу при тумблере.
 */
import type { SessionRunner } from "../../../core/bootstrap/session-runner";
import type { ToolOverrideSet, WebToolInfo, WebToolView } from "../state";

/** Пустой набор переопределений (общий readonly, не мутируется). */
export const NO_OVERRIDES: ToolOverrideSet = { enabled: [], disabled: [] };

/** Нормализованный набор overrides для сессии. */
export function overridesFor(
  map: Map<string, ToolOverrideSet>,
  sessionId: string,
): ToolOverrideSet {
  return map.get(sessionId) ?? NO_OVERRIDES;
}

/** Базовое вхождение тула в набор по тегам (без ручных overrides). */
function baseVisible(tool: WebToolInfo, tags: readonly string[]): boolean {
  if (tags.length === 0) return true;
  if (tool.alwaysOn) return true;
  return (tool.tags ?? []).some((tag) => tags.includes(tag));
}

/**
 * Применяет overrides к живому раннеру: контекст исполнения и (для включённых)
 * теги, чтобы tag-гейты промпта видели тот же набор, что и схема LLM.
 */
export function applyToolOverrides(runner: SessionRunner, overrides: ToolOverrideSet): void {
  runner.toolCtx.toolOverrides = {
    enabled: [...overrides.enabled],
    disabled: [...overrides.disabled],
  };
  const tags = runner.toolCtx.activeToolTags;
  if (!tags) return;
  for (const name of overrides.enabled) {
    const tool = runner.registry.get(name);
    for (const tag of tool?.tags ?? []) {
      if (!tags.includes(tag)) tags.push(tag);
    }
  }
}

/** Все тулы + вычисленный enabled/override для сессии. */
export function listTools(
  state: {
    pool: { getRunner(id: string): SessionRunner | undefined };
    toolOverrides: Map<string, ToolOverrideSet>;
    toolCatalog?: () => WebToolInfo[];
    config?: { tools?: { defaultTags?: string[] } };
  },
  sessionId: string,
): WebToolView[] {
  const runner = state.pool.getRunner(sessionId);
  const catalog: WebToolInfo[] = runner
    ? runner.registry.getAll().map((t) => ({
        name: t.name,
        description: t.description,
        tags: t.tags,
        alwaysOn: t.alwaysOn,
      }))
    : (state.toolCatalog?.() ?? []);
  const tags = runner?.toolCtx.activeToolTags ?? state.config?.tools?.defaultTags ?? [];
  const overrides = overridesFor(state.toolOverrides, sessionId);
  return catalog.map((tool) => {
    const override = overrides.disabled.includes(tool.name)
      ? "off"
      : overrides.enabled.includes(tool.name)
        ? "on"
        : null;
    return {
      ...tool,
      enabled: override ? override === "on" : baseVisible(tool, tags),
      override,
    };
  });
}

/** Пишет один тумблер и сразу применяет его к живому раннеру. */
export function setToolOverride(
  state: {
    pool: { getRunner(id: string): SessionRunner | undefined };
    toolOverrides: Map<string, ToolOverrideSet>;
  },
  sessionId: string,
  name: string,
  enabled: boolean,
): ToolOverrideSet {
  const prev = overridesFor(state.toolOverrides, sessionId);
  const next: ToolOverrideSet = {
    enabled: prev.enabled.filter((n) => n !== name),
    disabled: prev.disabled.filter((n) => n !== name),
  };
  (enabled ? next.enabled : next.disabled).push(name);
  state.toolOverrides.set(sessionId, next);
  const runner = state.pool.getRunner(sessionId);
  if (runner) applyToolOverrides(runner, next);
  return next;
}
