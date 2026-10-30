/**
 * Статус-уведомление о долгой проверке (A15).
 *
 * Инвариант «прошлая проверка молчит» (`tests/critic-degrade-feed.test.ts`)
 * сохраняется: строка появляется, только если работа действительно длится
 * дольше порога. Быстрый путь не пишет ничего.
 */
export type StopNotice = () => void;

/**
 * Вызывает `onSlow` один раз через `delayMs`, если к этому моменту вызов
 * `stop()` не случился.
 * @param delayMs порог «это уже долго», мс
 * @param onSlow действие (статус-строка в ленту)
 * @returns идемпотентная остановка таймера
 */
export function noticeAfter(delayMs: number, onSlow: () => void): StopNotice {
  const timer = setTimeout(onSlow, delayMs);
  // Не держим процесс живым из-за уведомления.
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
}
