// Транспортные лимиты web-поверхности (тело, кап очереди).
//
// Отдельным модулем, чтобы `state.ts` и `util.ts` оба читали `MAX_BODY_BYTES`,
// не импортируя друг друга (это ребро было одним из двух webui-циклов).
import { DEFAULT_MAX_BODY_BYTES, MAX_BODY_BYTES } from "../../runtime/http-body";

/**
 * Максимум байт тела запроса. Должен вмещать до `MAX_IMAGES` прикреплённых
 * изображений: файл до 50 МБ раздувается base64 ≈ до 70 МБ на изображение,
 * итого 10 × 70 МБ ≈ 700 МБ + текст — отсюда 768 МБ.
 * Источник — нейтральный runtime-слой (его делит и `mma serve`).
 */
export { MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES } from "../../runtime/http-body";

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
 * Источник — нейтральный runtime-слой (`RunPool` живёт там же).
 */
export { MAX_QUEUE_LENGTH } from "../../runtime/run-pool/limits";
