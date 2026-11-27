/**
 * Снимок исходящего запроса (U20): состав `system → messages → tools` после DLP,
 * до `fetch`. Fail-open. bootstrap связывает sink с `session.jsonl` и SSE.
 */

import { createHash } from "node:crypto";

/** Длина hex-префикса SHA-256 в корреляторе системного промпта. */
export const SYSTEM_HASH_HEX = 16;

/** Коррелятор полного system: короткий hex SHA-256 (не токен безопасности). */
export function systemHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, SYSTEM_HASH_HEX);
}

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

/** Дефиниция тула в снимке: имя, описание и коррелятор JSON-схемы. */
export interface SnapshotTool {
  name: string;
  description?: string;
  descriptionClipped?: boolean;
  /** SHA-256 `JSON.stringify(parameters)`, 16 hex — какая схема реально ушла. */
  parametersSha256?: string;
  /** Длина полной схемы до сериализации описания. */
  parametersChars?: number;
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
  /** Системный промпт был обрезан по капу снимка. */
  systemClipped?: boolean;
  /** Длина полного system до обрезки. */
  systemChars?: number;
  /** SHA-256 полного (после DLP) system, первые 16 hex. */
  systemSha256?: string;
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
// Webui-мост или ядро: кто пишет llm_request в session.jsonl. Иначе один и тот
// же снимок попадает в журнал дважды (SSE при этом остаётся у webui).
let persistenceOwner = false;

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

/** Отметить, что webui уже пишет снимки в журнал (ядро не дублирует). */
export function setSnapshotPersistenceOwner(owner: boolean): void {
  persistenceOwner = owner;
}

/** true, когда журнал снимков ведёт webui-мост. */
export function hasSnapshotPersistenceOwner(): boolean {
  return persistenceOwner;
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

/** Псевдоним DLP → метка класса: id обратим, в лог он не попадает (INV-DLP-1). */
export function maskTokenIds(text: string): string {
  return text.replace(/<\s*([A-Za-z][A-Za-z-]*)\s*:[^>]*>/g, "‹$1›");
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
    const text = maskTokenIds(textOfContent(rec.content));
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

  const systemFull = maskTokenIds(systemParts.join("\n\n"));
  const systemClip = clip(systemFull, SNAPSHOT_LIMITS.system);
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
      const desc =
        typeof rec.description === "string"
          ? clip(maskTokenIds(rec.description), SNAPSHOT_LIMITS.toolDescription)
          : undefined;
      if (desc?.clipped) truncated = true;
      const paramsText =
        rec.parameters && typeof rec.parameters === "object"
          ? JSON.stringify(rec.parameters)
          : undefined;
      tools.push({
        name,
        ...(desc ? { description: desc.text } : {}),
        ...(desc?.clipped ? { descriptionClipped: true } : {}),
        ...(paramsText
          ? {
              parametersSha256: systemHash(paramsText),
              parametersChars: paramsText.length,
            }
          : {}),
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
    systemClipped: systemClip.clipped || undefined,
    systemChars: systemFull.length,
    systemSha256: systemHash(systemFull),
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
