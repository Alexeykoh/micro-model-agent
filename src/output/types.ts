// Типы шины вывода: уровни, события, подписчики, стоки-приёмники.
export type OutputLevel = "debug" | "info" | "warn" | "error";
/** Вид события: log — строка с префиксом, raw — как есть, block — блок. */
export type OutputKind = "log" | "raw" | "block";
/** Поток вывода события. */
export type OutputStream = "stdout" | "stderr";

/**
 * Источник события (INV-13): кто произвёл запись.
 * `mma` — хост/CLI, `core` — ядро, `module:<name>` — модуль, `tool:<name>` — тул.
 */
export type Source = "mma" | "core" | `module:${string}` | `tool:${string}`;

/** Событие вывода: продюсеры эмитят, стоки рисуют/сохраняют. */
export interface OutputEvent {
  /** Порядковый номер в шине. */
  id: number;
  /** Время создания (мс). */
  ts: number;
  level: OutputLevel;
  /** Источник записи (INV-13): `mma`, `core`, `module:<name>` или `tool:<name>`. */
  source: Source;
  kind: OutputKind;
  /** Текст, готовый для терминала (может содержать ANSI). */
  text: string;
  stream?: OutputStream;
  /** Сессия-владелец события; отсутствует у процессно-глобальных сообщений. */
  sessionId?: string;
  /** Машиночитаемая нагрузка для нетерминальных поверхностей. */
  data?: Record<string, unknown>;
}

/** Подписчик шины: получает каждое событие. */
export type OutputSubscriber = (ev: OutputEvent) => void;

/** Приёмник: шина, умеющая эмитить события (id/ts проставляет сама). */
export interface OutputSink {
  emit(ev: Omit<OutputEvent, "id" | "ts">): OutputEvent;
}
