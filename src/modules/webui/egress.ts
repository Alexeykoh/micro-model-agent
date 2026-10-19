/**
 * E2 (`mma web`): единая DLP-редакция REST-ответов и SSE.
 *
 * Шов один — на транспорте: ответ оборачивается в `filterResponse` в диспетчере,
 * поэтому все роуты (`/api/state`, `/api/skills`, `/api/file`, …) и весь SSE
 * проходят через один `EgressGuard` (INV-D3/D7). JSON парсится и проектируется
 * структурно (R5: сканируются и тела значений), SSE — по `data:`-блокам.
 * Событие до записи не меняется: редакция идёт над копией для конкретного
 * клиента. Карта токенов наружу не попадает.
 */
import type { ServerResponse } from "node:http";
import { homedir, hostname, userInfo } from "node:os";
import type { PolicyContext } from "../security/data-policy/context";
import { DEFAULT_DATA_POLICY } from "../security/data-policy/defaults";
import { createGuard } from "../security/data-policy/guard";
import { TokenMap } from "../security/data-policy/tokens";
import type { DataPolicyConfig, EgressGuard } from "../security/data-policy/types";
import type { ConfigStore } from "./state";

/** Режим ответа: JSON/текст (буферизуем) или SSE (по блокам). */
export type FilterMode = "json" | "sse";

type AnyFn = (...args: unknown[]) => unknown;

/** Карта токенов веб-поверхности (общая для всех соединений процесса). */
const tokenMap = new TokenMap();

let cached: {
  config: DataPolicyConfig;
  workspace: string;
  guard: EgressGuard<unknown, unknown>;
} | null = null;

/** Узкая роль: API-egress нужны только живой конфиг и корень workspace. */
export type EgressState = ConfigStore & { workspace?: string };

/** Guard для API-egress; `undefined` — политика выключена (kill-switch). */
export function apiGuard(s: EgressState): EgressGuard<unknown, unknown> | undefined {
  const config = s.config?.security?.dataPolicy ?? DEFAULT_DATA_POLICY;
  if (!config.enabled) return undefined;
  const workspace = s.workspace ?? process.cwd();
  if (cached && cached.config === config && cached.workspace === workspace) return cached.guard;
  const guard = createGuard({
    config,
    target: { kind: "api", trusted: false },
    ctx: policyContext(workspace),
    map: tokenMap,
  });
  cached = { config, workspace, guard };
  return guard;
}

/** Машинный контекст для value-based детекции на API-поверхности. */
function policyContext(baseDir: string): PolicyContext {
  return {
    baseDir,
    home: homedir(),
    hostname: hostname(),
    username: sessionUsername(),
    platform: process.platform,
    arch: process.arch,
    env: process.env,
  };
}

function sessionUsername(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return process.env.USERNAME ?? process.env.USER;
  }
}

/**
 * Обернуть `ServerResponse`: текстовые чанки редактируются, бинарь (Buffer)
 * проходит как есть — файлы/изображения нельзя портить.
 */
export function filterResponse(
  res: ServerResponse,
  guard: EgressGuard<unknown, unknown> | undefined,
  mode: FilterMode,
): ServerResponse {
  if (!guard) return res;
  let buffer = "";
  return new Proxy(res, {
    get(target, prop) {
      if (prop === "write") {
        return (chunk: unknown, ...rest: unknown[]): boolean => {
          if (mode === "json" && typeof chunk === "string") {
            buffer += chunk;
            return true;
          }
          return (target.write as AnyFn).call(
            target,
            mode === "sse" ? filterSseChunk(chunk, guard) : chunk,
            ...rest,
          ) as boolean;
        };
      }
      if (prop === "end") {
        return (chunk?: unknown, ...rest: unknown[]): unknown => {
          if (mode !== "json") {
            if (chunk !== undefined) {
              (target.write as AnyFn).call(target, filterSseChunk(chunk, guard));
            }
            return (target.end as AnyFn).call(target, undefined, ...rest);
          }
          if (typeof chunk === "string") buffer += chunk;
          else if (chunk !== undefined) {
            // Бинарь: накопленный текст отдаём как есть, байты — не трогаем.
            if (buffer) (target.write as AnyFn).call(target, buffer);
            buffer = "";
            return (target.end as AnyFn).call(target, chunk, ...rest);
          }
          const out = filterJson(buffer, guard);
          buffer = "";
          return (target.end as AnyFn).call(target, out, ...rest);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as AnyFn).bind(target) : value;
    },
  });
}

/** JSON — структурная проекция; не-JSON текст (например, `/api/file`) — как текст. */
function filterJson(body: string, guard: EgressGuard<unknown, unknown>): string {
  if (!body) return body;
  try {
    return JSON.stringify(guard.filterClient(JSON.parse(body)));
  } catch {
    return guard.filterClient(body);
  }
}

/** SSE-чанк: блоки `\n\n`, внутри — строки `data: <json>`. */
function filterSseChunk(chunk: unknown, guard: EgressGuard<unknown, unknown>): unknown {
  if (typeof chunk !== "string" || chunk.length === 0) return chunk;
  return chunk
    .split("\n\n")
    .map((block) => {
      if (block.trim().length === 0) return block;
      return block
        .split("\n")
        .map((line) => {
          if (!line.startsWith("data: ")) return line;
          try {
            return `data: ${JSON.stringify(guard.filterClient(JSON.parse(line.slice(6))))}`;
          } catch {
            return line;
          }
        })
        .join("\n");
    })
    .join("\n\n");
}
