// Модели именованной записи провайдера для таблицы экспертов
// (`GET /api/models?provider=`). Вынесено из `write.ts` (правило 6: файл на
// потолке строк). Кеш живёт в `settings.modelsByProvider`.
import { api } from "../api.js";
import { settings } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { loadModels } from "./write.js";

/** Имя активной записи провайдера из живого конфига. */
function activeProviderName(): string {
  const provider: Dict = (settings.config && settings.config.provider) || {};
  return String(provider.active || provider.type || "");
}

/** Загрузки моделей в полёте: параллельные рендеры не плодят опросы. */
const inflight = new Set<string>();

/**
 * Синхронный список моделей записи провайдера для редактора экспертов.
 * Пустое имя / активная запись → список активного провайдера (`settings.models`).
 */
export function modelOptionsFor(provider: string): string[] {
  const name = String(provider || "").trim();
  if (!name || name === activeProviderName()) return (settings.models || []).map(String);
  return settings.modelsByProvider[name]?.models || [];
}

/** true — список этой записи известен и уже догрузился (не `loading`). */
export function hasModelsFor(provider: string): boolean {
  const name = String(provider || "").trim();
  // Inherit: список активного провайдера грузится отдельно (`loadModels`);
  // до его прихода `settings.models` пуст и редактор должен дозагрузить.
  if (!name || name === activeProviderName()) return settings.modelsReady;
  const entry = settings.modelsByProvider[name];
  return !!entry && !entry.loading;
}

/**
 * Модели конкретной записи провайдера (`GET /api/models?provider=`).
 * Возвращает `true`, если запрос действительно выполнялся (список мог
 * обновиться и UI стоит перерисовать), и `false`, если такая загрузка уже
 * идёт — иначе редактор таблицы зацикливал бы `draw()` на время загрузки.
 * Первый запрос к записи отвечает `loading: true` — сервер запускает
 * `listModels()` фоном; опрашиваем с малым лимитом (до ~6 с).
 * Пустое имя (inherit) — обычный список активного провайдера.
 */
export async function loadModelsFor(provider: string): Promise<boolean> {
  const name = String(provider || "").trim();
  if (!name || name === activeProviderName()) {
    await loadModels();
    return true;
  }
  if (inflight.has(name)) return false;
  inflight.add(name);
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      const r = await api<{ models?: string[]; loading?: boolean }>(
        `/api/models?provider=${encodeURIComponent(name)}`,
      );
      if (!r.ok || !r.data) return false;
      const models = Array.isArray(r.data.models) ? r.data.models : [];
      const loading = !!r.data.loading;
      settings.modelsByProvider[name] = { models, loading };
      if (!loading) return true;
      await new Promise((res) => setTimeout(res, 500));
    }
    // Не сдаёмся молча: `loading` остаётся true, и следующий рендер повторит.
    return true;
  } finally {
    inflight.delete(name);
  }
}
