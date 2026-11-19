/** Генераторы id ресурсов Agent Service API: job и webhook event. */
import { randomBytes } from "node:crypto";

/** `job_<ts36>_<hex>` — адресуемость хода; стабилен в рамках процесса. */
export function newJobId(): string {
  return `job_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

/** `evt_<ts36>_<hex>` — стабильный id webhook-события (дедуп у получателя). */
export function newEventId(): string {
  return `evt_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}
