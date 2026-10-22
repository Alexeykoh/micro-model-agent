/**
 * Дефы `service.*` (Agent Service API v1). Вынесены из `registry-extra.ts`
 * (правило 6): таблица сервиса растёт вместе с поверхностью, общий реестр — нет.
 */
import type { AppConfig } from "./types";
import type { ConfigKeyDef } from "./registry";
import { DEFAULTS } from "./defaults";

function int(
  key: string,
  min: number,
  max: number,
  step: number,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
): ConfigKeyDef {
  return { key, aliases: [], domain: "service", valueType: "int", min, max, step, effects: [], get, set };
}

function str(
  key: string,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
): ConfigKeyDef {
  return { key, aliases: [], domain: "service", valueType: "string", effects: [], get, set };
}

function bool(
  key: string,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
): ConfigKeyDef {
  return { key, aliases: [], domain: "service", valueType: "bool", effects: [], get, set };
}

/** Необязательная строка: пустое значение очищает в `undefined`. */
function optString(
  key: string,
  get: (c: AppConfig) => string,
  set: (c: AppConfig, value: string | undefined) => void,
): ConfigKeyDef {
  return {
    ...str(key, get, (c, v) => {
      const s = String(v ?? "").trim();
      set(c, s === "" ? undefined : s);
    }),
    allowEmpty: true,
  };
}

/** Все ключи `service.*` в порядке отображения. */
export const SERVICE_DEFS: ConfigKeyDef[] = [
  int("service.port", 1, 65535, 1,
    (c) => c.service.port,
    (c, v) => { c.service.port = v as number; }),
  str("service.host",
    (c) => c.service.host,
    (c, v) => { c.service.host = String(v).trim() || DEFAULTS.service.host; }),
  optString("service.token",
    (c) => c.service.token ?? "",
    (c, value) => { c.service.token = value; }),
  optString("service.tenant",
    (c) => c.service.tenant ?? "",
    (c, value) => { c.service.tenant = value; }),
  int("service.resultRetentionDays", 1, 365, 1,
    (c) => c.service.resultRetentionDays,
    (c, v) => { c.service.resultRetentionDays = v as number; }),
  int("service.idempotencyTtlHours", 1, 720, 1,
    (c) => c.service.idempotencyTtlHours,
    (c, v) => { c.service.idempotencyTtlHours = v as number; }),
  int("service.syncWaitMs", 0, 120_000, 1000,
    (c) => c.service.syncWaitMs,
    (c, v) => { c.service.syncWaitMs = v as number; }),
  int("service.maxQueueLength", 1, 100, 1,
    (c) => c.service.maxQueueLength,
    (c, v) => { c.service.maxQueueLength = v as number; }),
  int("service.callbackTimeoutMs", 1000, 120_000, 1000,
    (c) => c.service.callbackTimeoutMs,
    (c, v) => { c.service.callbackTimeoutMs = v as number; }),
  optString("service.webhookSecret",
    (c) => c.service.webhookSecret ?? "",
    (c, value) => { c.service.webhookSecret = value; }),
  bool("service.webhookAllowHttp",
    (c) => c.service.webhookAllowHttp ?? false,
    (c, v) => { c.service.webhookAllowHttp = Boolean(v); }),
];
