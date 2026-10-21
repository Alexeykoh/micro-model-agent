// Общие транспортные лимиты без внутренних импортов.
//
// Отдельным модулем, чтобы `state.ts` и `util.ts` оба читали `MAX_BODY_BYTES`,
// не импортируя друг друга (это ребро было одним из двух webui-циклов).
/**
 * Максимум байт тела запроса. Должен вмещать до `MAX_IMAGES` прикреплённых
 * изображений: файл до 50 МБ раздувается base64 ≈ до 70 МБ на изображение,
 * итого 10 × 70 МБ ≈ 700 МБ + текст — отсюда 768 МБ.
 */
export const MAX_BODY_BYTES = 768 * 1024 * 1024;

/**
 * Кап тела для обычных маршрутов (конфиг, настройки, команды): 1 МБ.
 * Раньше все маршруты делили кап сообщений (768 МБ) — 5 МБ в `/api/config`
 * проходили (аудит §6.3/§6.4).
 */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** Кап тела для маршрута сообщений: картинки до 50 МБ × 10. */
export const MESSAGE_MAX_BODY_BYTES = MAX_BODY_BYTES;

/**
 * Кап тела по маршруту. Ключ — `METHOD /path`; всё остальное — дефолтный кап.
 * Знание о маршрутах живёт здесь, чтобы чтение тела было одной точкой.
 */
const ROUTE_BODY_CAPS: Record<string, number> = {
  "POST /api/message": MESSAGE_MAX_BODY_BYTES,
};

/** Кап тела для маршрута (по методу и пути). */
export function bodyCapFor(method: string | undefined, pathname: string): number {
  if (!method) return DEFAULT_MAX_BODY_BYTES;
  return ROUTE_BODY_CAPS[`${method.toUpperCase()} ${pathname}`] ?? DEFAULT_MAX_BODY_BYTES;
}

/**
 * Максимум сообщений в очереди входящих (`POST /api/message` во время хода).
 * Хвост сверх капа отклоняется `429 queue_full` — очередь не должна расти
 * безгранично, пока пользователь спамит в долгий ход.
 */
export const MAX_QUEUE_LENGTH = 5;
