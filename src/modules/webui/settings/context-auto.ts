// Включение режима auto для окна контекста: спросить провайдера прямо сейчас.
/**
 * `POST /api/config {key:"contextAuto", value:true}` включает флаг, но само
 * значение `contextWindow` проба приходит обновить только на старте/смене
 * модели — юзер увидел бы «auto» со старым числом. Хендлер вызывает этот хелпер
 * ДО персиста/reconfigure, чтобы бюджеты и снапшот сразу пересчитались под
 * реальное окно активной модели.
 *
 * Порядок — общий `probeProviderContext` (LM Studio native → Ollama → llama.cpp
 * → OpenAI-compat `/models` → models.dev). Fail-open: бэкенд молчит или мёртв —
 * окно остаётся прежним, флаг auto всё равно включается (проба на ближайшем
 * старте/смене модели доработает).
 */
import type { AppConfig } from "../../../config/types";
import { probeProviderContext } from "../../../llm/provider-context";
import { activeProviderEndpoint } from "../../providers/manager";

/** Таймаут одной ступени пробы: локальные бэкенды отвечают за миллисекунды. */
const PROBE_TIMEOUT_MS = 2000;
/** Потолок суммарного ожидания — POST не должен висеть дольше. */
const PROBE_DEADLINE_MS = 4000;

export interface AutoContextResult {
  /** Провайдер сообщил окно, и оно применено к `config.contextWindow`. */
  probed: boolean;
  /** Итоговое окно: результат пробы либо прежнее значение (fail-open). */
  contextWindow: number;
  /** Модель, о которой сообщил провайдер (только при успешной пробе). */
  model?: string;
}

/** Оборачивает промис потолком времени; по дедлайну — null (сама проба доживает в фоне). */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Спрашивает активный провайдер об окне для активной модели и записывает его в
 * `config.contextWindow` (ин-плейс — тот же объект у живого конфига).
 * @param config живой конфиг приложения.
 * @returns итог: применилось ли окно провайдера и что в итоге в конфиге.
 */
export async function applyAutoContext(config: AppConfig): Promise<AutoContextResult> {
  const endpoint = activeProviderEndpoint(config.provider);
  let detected: { model: string; actual: number } | null = null;
  try {
    detected = await withDeadline(
      probeProviderContext(endpoint.baseUrl, config.model, {
        apiKey: endpoint.apiKey,
        providerType: endpoint.type,
        timeoutMs: PROBE_TIMEOUT_MS,
      }),
      PROBE_DEADLINE_MS,
    );
  } catch {
    detected = null;
  }
  if (detected) config.contextWindow = detected.actual;
  return detected
    ? { probed: true, contextWindow: detected.actual, model: detected.model }
    : { probed: false, contextWindow: config.contextWindow };
}
