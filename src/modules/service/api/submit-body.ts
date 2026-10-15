/**
 * Валидация тела сабмита задачи (`POST /v1/tasks`).
 *
 * Вынесено из `tasks-api.ts` (правило 6, ≤300 строк): разбор тела — чистая
 * функция без состояния сервиса, её удобно тестировать и она не должна расти
 * вместе с роутингом.
 *
 * `callbackUrl` проверяется политикой исходящих вызовов (W13, D5): адресат
 * приходит из тела запроса, поэтому отказ виден синхронно (422), а не после
 * ретраев доставки. Проверка повторяется в `deliverWebhook` — сабмит и доставка
 * живут в разных процессах времени.
 */
import type { NetworkSecurityConfig } from "../../../config/types";
import { checkOutboundUrl } from "../../security/outbound-policy";
import type { TaskMode, TaskOutputSpec } from "../runtime/task-registry";
import { problem, type ProblemDetails } from "../runtime/problem";

export interface SubmitParams {
  input: string;
  mode: TaskMode;
  output?: TaskOutputSpec;
  toolAllowlist: string[];
  timeoutMs?: number;
  callbackUrl?: string;
  externalRef?: string;
  wait: boolean;
}

export type SubmitParse = { ok: true; params: SubmitParams } | { ok: false; problem: ProblemDetails };

function submitError(title: string, status: number, detail?: string): SubmitParse {
  return { ok: false, problem: problem({ type: "validation", title, status, ...(detail ? { detail } : {}) }) };
}

/** Валидирует тело сабмита; ошибка → готовый Problem Details. */
export function parseSubmitBody(
  body: Record<string, unknown>,
  networkConfig?: NetworkSecurityConfig,
): SubmitParse {
  const input = typeof body.input === "string" ? body.input : "";
  if (!input.trim()) return submitError("input required", 400);

  const callbackUrl = typeof body.callbackUrl === "string" ? body.callbackUrl : undefined;
  if (callbackUrl !== undefined) {
    const check = checkOutboundUrl(callbackUrl, "module:service", {
      networkConfig,
      operation: "service.callback.submit",
    });
    if (!check.allowed) return submitError("callbackUrl not allowed", 422, check.reason);
  }

  const output = parseOutput(body.output);
  if (!output.ok) return submitError("invalid output spec", 422, output.detail);
  const toolAllowlist = parseStringArray(body.toolAllowlist);
  if (toolAllowlist === null) return submitError("invalid toolAllowlist", 400);
  const timeout = parseTimeout(body.timeoutMs);
  if (!timeout.ok) return submitError("invalid timeoutMs", 400);
  return {
    ok: true,
    params: {
      input,
      mode: body.mode === "interactive" ? "interactive" : "job",
      ...(output.output ? { output: output.output } : {}),
      toolAllowlist,
      ...(timeout.value !== undefined ? { timeoutMs: timeout.value } : {}),
      ...stringParam(body, "callbackUrl"),
      ...stringParam(body, "externalRef"),
      wait: body.wait === true,
    },
  };
}

/** Струнная опция тела как `{[key]: value}` или пустой объект. */
function stringParam(body: Record<string, unknown>, key: string): Record<string, string> {
  const value = body[key];
  return typeof value === "string" ? { [key]: value } : {};
}

/** Проверяет необязательный числовой таймаут: absent → ok, битый → не ok. */
function parseTimeout(raw: unknown): { ok: true; value?: number } | { ok: false } {
  if (raw === undefined) return { ok: true };
  const value = parseOptionalInt(raw);
  return value === undefined ? { ok: false } : { ok: true, value };
}

function parseOptionalInt(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  return undefined;
}

/** True для обычного JSON-объекта (не массив/null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFormat(value: unknown): value is "text" | "json" {
  return value === "text" || value === "json";
}

function failOutput(detail: string): { ok: false; detail: string } {
  return { ok: false, detail };
}

function parseOutput(
  raw: unknown,
): { ok: true; output?: TaskOutputSpec } | { ok: false; detail: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (!isRecord(raw)) return failOutput("output must be an object");
  const { format, schema } = raw;
  if (!isFormat(format)) return failOutput("output.format must be 'text' or 'json'");
  if (format === "json" && schema !== undefined && !isRecord(schema)) {
    return failOutput("output.schema must be an object");
  }
  return { ok: true, output: { format, ...(schema !== undefined ? { schema } : {}) } };
}

function parseStringArray(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) return null;
  return raw as string[];
}