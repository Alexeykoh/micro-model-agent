/**
 * Адаптер OpenTelemetry GenAI (P0 osservability 1/2,
 * спека `2026-11-09-otel-design.md`): единые имена атрибутов `gen_ai.*`
 * (Development, меняются только здесь) + связки по thread/session.
 * Без `otel.enabled` — no-op без fetch.
 */
import { fetchOutbound } from "../security/outbound-policy";

/** Атрибуты, общие для каждого спано (связка trace↔session). */
export type SpanAttributes = Record<string, string | number | boolean>;

/** Спан завершён в стиле fail-open (описание статуса — причина). */
export interface SpanHandle {
  ended: (status: "ok" | "error", attrs?: SpanAttributes) => Promise<void>;
}

let idSeq = 0;
function genId(): string {
  return `${(Date.now() % 1_000_000).toString(36)}${(++idSeq).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const noSpan: SpanHandle = { ended: async () => {} };

export interface OtelAdapterConfig {
  enabled: boolean;
  endpoint: string;
  serviceName: string;
}

/** Адаптер (синглтон по процессу — спавны одноразовые, переконфиг не нужен). */
export class OtelAdapter {
  private threadId: string | undefined;
  private sessionId: string | undefined;
  private spans: Array<Record<string, unknown>> = [];
  private metrics: Array<{ name: string; value: number; labels: Record<string, string> }> = [];

  constructor(private readonly cfg: OtelAdapterConfig) {}

  /** Задать связки потока для следующих спанов. */
  setThread(threadId?: string, sessionId?: string): void {
    this.threadId = threadId;
    this.sessionId = sessionId;
  }

  private link(): SpanAttributes {
    const out: SpanAttributes = {};
    if (this.threadId) out["mma.thread_id"] = this.threadId;
    if (this.sessionId) out["mma.session_id"] = this.sessionId;
    return out;
  }

  /**
   * Начать спан. `kind`: workflow|model|tool (семантика gen_ai.* — см. `ATTRS`).
   * При выключенном адаптере возвращает no-op (без fetch).
   */
  startSpan(kind: "agent.run" | "llm.chat" | "tool.call", attrs: SpanAttributes): SpanHandle {
    if (!this.cfg.enabled) return noSpan;
    const base: SpanAttributes = {
      ...this.link(),
      ...attrs,
    };
    const span: Record<string, unknown> = {
      id: genId(),
      kind,
      startNs: Date.now() * 1_000_000,
      attrs: base,
    };
    return {
      ended: async (status, endAttrs) => {
        span.attrs = { ...base, ...(endAttrs ?? {}), "gen_ai.status": status };
        span.endNs = Date.now() * 1_000_000;
        this.spans.push(span);
        if (this.spans.length >= 20) await this.flush();
      },
    };
  }

  /** Счётчик метрик (в памяти, flush батчем). */
  incMetric(name: string, value: number, labels: Record<string, string> = {}): void {
    if (!this.cfg.enabled) return;
    this.metrics.push({ name, value, labels });
  }

  /** Финалка: OTLP JSON POST на `{endpoint}/v1/traces`; fail-silent. */
  async flush(): Promise<void> {
    if (!this.cfg.enabled || !this.cfg.endpoint || this.spans.length === 0) return;
    const url = `${this.cfg.endpoint.replace(/\/$/, "")}/v1/traces`;
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: this.cfg.serviceName } }] },
          scopeSpans: [
            {
              scope: { name: "mma-otel" },
              spans: this.spans.map((s) => ({
                traceId: s.id,
                spanId: genId().slice(-16),
                name: String(s.kind),
                kind: 3,
                startTimeUnixNano: String(s.startNs),
                endTimeUnixNano: String((s as { endNs?: number }).endNs ?? s.startNs),
                attributes: Object.entries((s.attrs as Record<string, unknown>) ?? {}).map(([key, value]) => ({
                  key,
                  value: { stringValue: String(value) },
                })),
                status: { code: 1 },
              })),
            },
          ],
        },
      ],
    };
    this.spans = [];
    try {
      const res = await fetchOutbound(url, "module:otel", { operation: "otel.export" }, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return; // fail-silent
    } catch {
      // fail-silent: экспорт не должен ронять ход
    }
  }
}

/** Дефолтный именованный адаптер (переконфигурируется при создании). */
let instance: OtelAdapter | null = null;

export function createOtelAdapter(cfg: OtelAdapterConfig): OtelAdapter {
  instance = new OtelAdapter(cfg);
  return instance;
}

export function getOtelAdapter(): OtelAdapter {
  if (!instance) instance = new OtelAdapter({ enabled: false, endpoint: "", serviceName: "mma" });
  return instance;
}
