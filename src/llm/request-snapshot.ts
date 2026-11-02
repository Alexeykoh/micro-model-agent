/**
 * Снимок **исходящего** запроса к провайдеру (U20): то, что реально уйдёт в
 * сеть — уже после DLP-проекции (`sanitizeChat`), но до `fetch`.
 *
 * Зачем: пользователь должен сам убедиться, что защита работает, и увидеть
 * точный состав промпта (`system → messages → tools`) и параметры вызова.
 * Снимок не содержит оригиналов по построению — их уже нет в теле запроса.
 *
 * Шов — процесс-глобальный sink (как `setEgressDiagnosticSink`): провайдер не
 * знает про сессии и журнал, а bootstrap связывает его с `session.jsonl` и SSE.
 * Fail-open: снимок не имеет права уронить вызов модели.
 */

/** Пределы снимка: агрегат для разбора, а не дамп. */
export const SNAPSHOT_LIMITS = {
  /** Символов на одно сообщение. */
  message: 8000,
  /** Символов на системный промпт. */
  system: 12000,
  /** Символов на описание тула. */
  toolDescription: 600,
  /** Символов на весь снимок. */
  total: 64000,
} as const;

/** Одно сообщение запроса в снимке. */
export interface SnapshotMessage {
  role: string;
  text: string;
  /** Текст обрезан по капу. */
  clipped?: boolean;
}

/** Дефиниция тула в снимке: имя + (усечённое) описание. */
export interface SnapshotTool {
  name: string;
  description?: string;
  descriptionClipped?: boolean;
}

/** Параметры вызова, влияющие на поведение модели. */
export interface SnapshotParams {
  maxTokens?: number;
  reasoningEffort?: string;
  reasoning?: string;
  temperature?: number;
  streamUsage?: boolean;
  toolChoice?: string;
}

/** Снимок запроса — единственная форма, которая уходит в лог/SSE. */
export interface LlmRequestSnapshot {
  ts: string;
  /** Стабильный id вызова: связывает запрос, ответ и Trace. */
  requestId: string;
  sessionId?: string;
  /** Распарсенный хост провайдера (без пути и query). */
  providerHost?: string;
  model: string;
  stream: boolean;
  params: SnapshotParams;
  /** Системный промпт (склеенные сообщения `role: system`). */
  system: string;
  /** Остальные сообщения в порядке отправки. */
  messages: SnapshotMessage[];
  tools: SnapshotTool[];
  /** Снимок усечён по общему капу. */
  truncated: boolean;
}

/** Приёмник снимков. */
export type RequestSnapshotSink = (snap: LlmRequestSnapshot) => void;

const sinkSet = new Set<RequestSnapshotSink>();
let seq = 0;

/**
 * Подписаться на снимки запросов; возвращает отписку.
 *
 * Шов — множественная подписка, а не одна глобальная функция: webui, CLI-журнал
 * и будущие экспортёры пользуются одним событием, а провайдер не знает ни про
 * одного из них. Пока подписчиков нет, снимок даже не строится.
 */
export function subscribeRequestSnapshots(fn: RequestSnapshotSink): () => void {
  sinkSet.add(fn);
  return () => sinkSet.delete(fn);
}

/** Включён ли сбор (проверка до построения снимка). */
export function requestSnapshotEnabled(): boolean {
  return sinkSet.size > 0;
}

/** Тестовый сброс счётчика id. */
export function resetRequestSnapshotSeq(): void {
  seq = 0;
}

/** Хост из `baseUrl`: без пути/креденшелов, пустой при ошибке разбора. */
function hostOf(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  for (const candidate of [baseUrl, `http://${baseUrl}`]) {
    try {
      const host = new URL(candidate).hostname.toLowerCase();
      return host.length > 0 ? host : undefined;
    } catch {
      /* пробуем следующую форму */
    }
  }
  return undefined;
}

/** Текст части контента: строка либо массив частей `{type,text}`. */
function textOfPart(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const rec = part as Record<string, unknown>;
  if (typeof rec.text === "string") return rec.text;
  if (rec.type === "image_url") return "[image]";
  return "";
}

/** Нормализовать `content` сообщения в строку. */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOfPart).join("");
  return "";
}

/** Обрезать строку по капу с маркером. */
function clip(text: string, cap: number): { text: string; clipped: boolean } {
  if (text.length <= cap) return { text, clipped: false };
  return { text: `${text.slice(0, cap)}… [truncated from ${text.length} chars]`, clipped: true };
}

function numOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Собрать снимок из тела запроса (форма OpenAI-совместимого API). */
export function buildRequestSnapshot(
  body: Record<string, unknown>,
  meta: { model: string; baseUrl?: string; stream: boolean; sessionId?: string },
): LlmRequestSnapshot {
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const systemParts: string[] = [];
  const messages: SnapshotMessage[] = [];
  let truncated = false;
  let used = 0;

  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const role = typeof rec.role === "string" ? rec.role : "user";
    const text = textOfContent(rec.content);
    if (role === "system") {
      systemParts.push(text);
      continue;
    }
    if (used >= SNAPSHOT_LIMITS.total) {
      truncated = true;
      break;
    }
    const capped = clip(text, SNAPSHOT_LIMITS.message);
    used += capped.text.length;
    messages.push({ role, text: capped.text, ...(capped.clipped ? { clipped: true } : {}) });
  }

  const systemClip = clip(systemParts.join("\n\n"), SNAPSHOT_LIMITS.system);
  if (systemClip.clipped) truncated = true;

  const tools: SnapshotTool[] = [];
  if (Array.isArray(body.tools)) {
    for (const raw of body.tools) {
      if (!raw || typeof raw !== "object") continue;
      const fn = (raw as Record<string, unknown>).function;
      if (!fn || typeof fn !== "object") continue;
      const rec = fn as Record<string, unknown>;
      const name = typeof rec.name === "string" ? rec.name : "";
      if (!name) continue;
      const desc = typeof rec.description === "string" ? clip(rec.description, SNAPSHOT_LIMITS.toolDescription) : undefined;
      if (desc?.clipped) truncated = true;
      tools.push({
        name,
        ...(desc ? { description: desc.text } : {}),
        ...(desc?.clipped ? { descriptionClipped: true } : {}),
      });
    }
  }

  const params: SnapshotParams = {
    ...(numOf(body.max_tokens) !== undefined ? { maxTokens: numOf(body.max_tokens) } : {}),
    ...(strOf(body.reasoning_effort) ? { reasoningEffort: strOf(body.reasoning_effort) } : {}),
    ...(numOf(body.temperature) !== undefined ? { temperature: numOf(body.temperature) } : {}),
    ...(strOf(body.tool_choice) ? { toolChoice: strOf(body.tool_choice) } : {}),
  };
  const chatKwargs = body.chat_template_kwargs;
  if (chatKwargs && typeof chatKwargs === "object") {
    const enable = (chatKwargs as Record<string, unknown>).enable_thinking;
    if (typeof enable === "boolean") params.reasoning = enable ? "thinking" : "off";
  } else if (params.reasoningEffort) {
    params.reasoning = params.reasoningEffort;
  }
  if (body.stream_options && typeof body.stream_options === "object") {
    params.streamUsage = (body.stream_options as Record<string, unknown>).include_usage === true;
  }

  seq += 1;
  return {
    ts: new Date().toISOString(),
    requestId: `req_${Date.now().toString(36)}_${seq}`,
    ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
    ...(hostOf(meta.baseUrl) ? { providerHost: hostOf(meta.baseUrl) } : {}),
    model: meta.model,
    stream: meta.stream,
    params,
    system: systemClip.text,
    messages,
    tools,
    truncated,
  };
}

/**
 * Снять снимок и отдать приёмнику. Никогда не бросает: сбой логирования не
 * имеет права уронить вызов модели (INV-15: fail-open не молчит — приёмник
 * сам решает, куда записать).
 */
export function captureRequestSnapshot(
  body: Record<string, unknown>,
  meta: { model: string; baseUrl?: string; stream: boolean; sessionId?: string },
): LlmRequestSnapshot | undefined {
  if (sinkSet.size === 0) return undefined;
  try {
    const snap = buildRequestSnapshot(body, meta);
    for (const sink of [...sinkSet]) {
      try {
        sink(snap);
      } catch {
        /* подписчик не имеет права уронить вызов модели */
      }
    }
    return snap;
  } catch {
    return undefined;
  }
}
