// Мост «петля агента → SSE» для `mma web`: буферизация чанков, капы вывода, скрытие секретов.
/**
 * Петля агента стримит текст/мету/reasoning крошечными кусками; форвард каждого
 * как есть затопил бы браузер и сокет. Текст, мета и reasoning буферизуются и
 * флашатся вместе (`flushMs`, ~350мс), а дискретные события жизненного цикла
 * (фаза, старт/конец тула, конец хода) сначала флашат буфер ради порядка.
 *
 * `onTurnEnd` ОБЯЗАН сбрасывать `state.busy = false`: сервер ставит `busy = true`
 * на `/api/message` и полагается на этот сброс, чтобы принять следующий сабмит.
 */
import type { SseEvent, RuntimeState, SseTransport } from "../state";
import { broadcast } from "../state";
import { syncBusy } from "./session-status";
import { redactContextSecrets } from "../../../core/api";
import { sanitizeOutputPlain } from "../../../ui/sanitize-output";
import type { MetaKind, StopReason } from "../../../core/types";
import type { ToolCall, ToolResult } from "../../../tools/types";
import type { HostStateSnapshot } from "../../../core/host";
import type { TurnSummary } from "../../types";
import { WEBUI_FORWARD_FLUSH_MS as DEFAULT_FLUSH_MS } from "../../../config/timeouts";

/**
 * Ненулевой снапшот плана в выделенном SSE-событии `plan`. Переиспользует
 * host-контракт, чтобы карточка браузера и сайдбар рендерили одну форму.
 */
export type PlanSnapshot = NonNullable<HostStateSnapshot["plan"]>;

/**
 * Вычищает credential-подобные строки внутри объекта аргументов тула,
 * сохраняя форму (браузер рендерит `args` структурно). Та же точечная
 * редактура, что в {@link scrubError}, — общий скраб покалечил бы обычные аргументы.
 */
function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return redactContextSecrets(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = scrubValue(val);
    return out;
  }
  return value;
}

/** Вычищает секреты из аргументов тула, сохраняя форму объекта. */
export function scrubToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const scrubbed = scrubValue(args);
  return scrubbed !== null && typeof scrubbed === "object"
    ? (scrubbed as Record<string, unknown>)
    : {};
}

/**
 * Потуловые капы тела результата для браузера. Длинный вывод (логи bash,
 * чтения файлов, хиты поиска) режется, чтобы одно событие не раздуло сокет
 * и ленту; маркер честно фиксирует обрезку.
 */
const TOOL_OUTPUT_CAPS: Record<string, number> = {
  browser: 8000,
  web_search: 6000,
  web_fetch: 4000,
  web_browse: 4000,
  bash: 16000,
  read_file: 12000,
  list_dir: 4000,
  grep: 4000,
  glob: 2000,
  download_file: 2000,
};
const DEFAULT_OUTPUT_CAP = 6000;

/** Обрезает вывод тула по капу; маркер показывает исходную длину. */
export function clipToolOutput(toolName: string, output: string): string {
  const cap = TOOL_OUTPUT_CAPS[toolName] ?? DEFAULT_OUTPUT_CAP;
  if (output.length <= cap) return output;
  return `${output.slice(0, cap)}\n… [truncated from ${output.length.toLocaleString()} chars]`;
}

/**
 * SSE-подмножество {@link TurnSummary} — `textLength` клиентам не шлётся.
 * `success` обязателен всегда; поля времени/счётчиков опциональны, чтобы
 * частичные сводки (напр. прерванных прогонов) были валидны.
 */
export type TurnEndSummary = Pick<TurnSummary, "success" | "interrupted"> &
  Partial<Pick<TurnSummary, "durationMs" | "toolCalls">> & {
    /** Машиночитаемая причина принудительной остановки, если была. */
    stopReason?: StopReason;
    /** Локализованный текст причины (печатается в ленте). */
    error?: string;
  };

/** Эффективная ступень reasoning текущей итерации (INV-R9). */
export interface ReasoningInfo {
  /** `default`, если механизм не применяется (решает бэкенд). */
  level: string;
  /** `policy` | `agent_override` | `fixed` | `none`. */
  source?: string;
}

/** Форвардер чанков петли в SSE-синк с буферизацией и сбросом busy. */
export interface Forwarder {
  onText(chunk: string): void;
  onMeta(chunk: string, kind?: MetaKind): void;
  onReasoning(chunk: string, info?: ReasoningInfo): void;
  onPhase(phase: string): void;
  onToolStart(call: ToolCall): void;
  onToolEnd(call: ToolCall, result: ToolResult, durationMs: number): void;
  /** Выделенное событие снапшота плана (после конца `plan`/`todo`-тула). */
  onPlan(plan: PlanSnapshot): void;
  onTurnEnd(summary: TurnEndSummary): void;
  flushNow(): void;
}

/**
 * URL'ы картинок тула для события `tool_end`: сохранённые refs →
 * `/api/sessions/:id/images/:name` (кэш + replay), без персиста (шифрованная
 * сессия) — inline data URL, live-only. Пусто — событие уходит без картинок.
 */
function imageUrlList(owner: string | null, result: ToolResult): string[] {
  if (result.imageRefs?.length && owner) {
    return result.imageRefs.map((r) => `/api/sessions/${owner}/images/${r.file}`);
  }
  if (result.images?.length) {
    return result.images.map((p) => p.image_url.url);
  }
  return [];
}

/** Строит форвардер на состояние и синк (дефолт — broadcast всем клиентам). */
export function makeForwarder(
  s: RuntimeState & SseTransport,
  sink: (ev: SseEvent) => void = (ev) => broadcast(ev, s),
  opts: { flushMs?: number; onQueueDrained?: (owner: string | null) => void; ownerRef?: { current: string | null } } = {},
): Forwarder {
  const flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
  const buf = {
    text: "",
    meta: "",
    reasoning: "",
    metaKind: undefined as MetaKind | undefined,
    reasoningInfo: undefined as ReasoningInfo | undefined,
  };
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    // Мета тулов/статуса (и выход плагинного `runOnMeta`) может нести ANSI-коды,
    // да и плагины красят текст — а терминала у браузера нет, и эскейпы встали бы
    // буквальным мусором `\u001b[2m…`. Режем здесь, в единственной точке, через
    // которую проходит каждый чанк текста/меты/reasoning.
    if (buf.reasoning) {
      sink({
        type: "reasoning",
        ts: Date.now(),
        chunk: sanitizeOutputPlain(buf.reasoning),
        ...(buf.reasoningInfo
          ? { level: buf.reasoningInfo.level, source: buf.reasoningInfo.source }
          : {}),
      });
      buf.reasoning = "";
      buf.reasoningInfo = undefined;
    }
    if (buf.text) {
      sink({ type: "text", ts: Date.now(), chunk: sanitizeOutputPlain(buf.text) });
      buf.text = "";
    }
    if (buf.meta) {
      sink({
        type: "meta",
        ts: Date.now(),
        chunk: sanitizeOutputPlain(buf.meta),
        ...(buf.metaKind ? { kind: buf.metaKind } : {}),
      });
      buf.meta = "";
      buf.metaKind = undefined;
    }
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, flushMs);
  };

  return {
    onText(chunk) {
      buf.text += chunk;
      schedule();
    },
    onMeta(chunk, kind) {
      // `retract` — гейт забраковал уже отстримленный черновик: отдельным
      // событием, чтобы клиент убрал черновик из ленты до переответа
      // (иначе финал встаёт дублем). В общий meta-буфер не кладём.
      if (kind === "retract") {
        flush();
        sink({ type: "retract", ts: Date.now(), reason: sanitizeOutputPlain(chunk) });
        return;
      }
      // Тела тулов и строки статуса не должны делить одно SSE-событие: клиент
      // quiet-гейтит `kind: "tool"`, а статус показывает всегда. При смене kind
      // сначала флашим, чтобы каждое событие несло чистый kind. События статуса
      // остаются байт-в-байт как раньше (без поля `kind`) — тегируются только тела.
      const next = kind ?? "status";
      if (buf.meta && (buf.metaKind ?? "status") !== next) flush();
      buf.meta += chunk;
      buf.metaKind = kind;
      schedule();
    },
    onReasoning(chunk, info) {
      buf.reasoning += chunk;
      // Уровень относится к итерации, а не к чанку: держим последний
      // известный, чтобы флаш нёс актуальную ступень (INV-R9).
      if (info) buf.reasoningInfo = info;
      schedule();
    },
    onPhase(phase) {
      flush();
      sink({ type: "phase", ts: Date.now(), phase });
    },
    onToolStart(call) {
      flush();
      sink({
        type: "tool_start",
        ts: Date.now(),
        toolCallId: call.id,
        name: call.name,
        args: scrubToolArgs(call.arguments),
      });
    },
    onToolEnd(call, result, durationMs) {
      flush();
      const images = imageUrlList(opts.ownerRef?.current ?? null, result);
      sink({
        type: "tool_end",
        ts: Date.now(),
        toolCallId: call.id,
        name: call.name,
        success: result.success,
        durationMs,
        output: sanitizeOutputPlain(redactContextSecrets(clipToolOutput(call.name, result.output || ""))),
        ...(images.length ? { images } : {}),
      });
    },
    onPlan(plan) {
      flush();
      sink({
        type: "plan",
        ts: Date.now(),
        steps: plan.steps,
        currentIndex: plan.currentIndex,
      });
    },
    onTurnEnd(summary) {
      // Владение: форвардер — единственный эмиттер `turn_end` и единственный
      // сброс для любого реально стартовавшего хода: legacy-флаги + слот
      // владельца в пуле (иначе поздний колбэк провала `submit` увидит чужой
      // резерв своим и продублирует error). Хук ниже пересчитает агрегаты
      // и дренует очередь (слот уже свободен, вызов синхронен).
      flush();
      s.busy = false;
      s.agentRunning = false;
      s.pool.forceRelease(opts.ownerRef?.current ?? null);
      syncBusy(s);
      s.turnSeq += 1;
      sink({ type: "turn_end", ts: Date.now(), turnSeq: s.turnSeq, ...summary });
      // Очередь входящих дренируется следующим ходом сразу (по одному):
      // слот уже свободен, вызов синхронен — вклиниться некому. Дренируем
      // слот ВЛАДЕЛЬЦА завершённого хода (ownerRef ставит раннер на старте),
      // а не legacy-пустышку: в legacy-режиме ходы разных сессий тоже
      // серийны, но очередь у каждой своя.
      opts.onQueueDrained?.(opts.ownerRef?.current ?? null);
    },
    flushNow: flush,
  };
}
