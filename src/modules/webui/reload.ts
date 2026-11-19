/**
 * Мягкий reload веб-поверхности (`/reload`): конфиг и `AGENTS.md` перечитывает
 * CLI-колбэк (`state.reload`), а здесь — всё, что принадлежит веб-рантайму:
 * сброс простаивающих раннеров, живой reload плагинов/скиллов и обновление
 * снапшота. Браузер и SSE-соединение не рвутся.
 */
import {
  broadcast,
  type ConfigStore,
  type RuntimeState,
  type SessionStore,
  type SseTransport,
  type WorkspaceStore,
} from "./state";
import type { WebReloadReport, WebUiWiring } from "./state-contracts";
import { pushState } from "./session/session-status";

/** Минимум состояния, которым пользуется мягкий reload. */
export type ReloadState = RuntimeState &
  SessionStore &
  ConfigStore &
  WorkspaceStore &
  SseTransport &
  Pick<WebUiWiring, "reload">;

/** Итог `/reload` для ленты: счётчики источников и отпущенных раннеров. */
export interface WebReloadSummary extends WebReloadReport {
  /** Сколько простаивающих раннеров сброшено (следующий ход — с новым промптом). */
  dropped: number;
}

/**
 * Применяет мягкий reload. Бросает, если колбэк не сконфигурирован (daemon-
 * адаптер без локального рантайма) — команда честно скажет об этом.
 */
export async function applySoftReload(state: ReloadState): Promise<WebReloadSummary> {
  const reload = state.reload;
  if (!reload) throw new Error("reload unavailable");
  const report = await reload();
  if (state.config && state.reconfigure) await state.reconfigure(state.config);
  const dropped = state.pool.dropIdle();
  state.plugins?.reload();
  state.skills?.reloadSources?.();
  if (state.agentsMd) state.agentsMd = { ...state.agentsMd, files: report.files };
  broadcast({ type: "config", ts: Date.now() }, state);
  pushState(state);
  return { ...report, dropped };
}
