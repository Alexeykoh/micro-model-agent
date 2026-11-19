/** HTTP-обвязка визарда: один `fetch` на `/api/setup*` с токеном и JSON. */
import { applyI18n } from "./setup-i18n.js";

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
}

export interface ApiOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

const token = new URLSearchParams(location.search).get("token") || "";

export async function api<T = unknown>(
  path: string,
  opts: ApiOptions = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = Object.assign({}, opts.headers || {});
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["x-mma-token"] = token;
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method || "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    return { ok: false, status: 0, data: null };
  }
  let data: T | null = null;
  try {
    data = (await res.json()) as T;
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

/** Подтягивает словари визарда; ошибка оставляет английские дефолты. */
export async function loadI18n(): Promise<void> {
  const r = await api<{ locale?: string; dicts?: Record<string, Record<string, string>> }>(
    "/api/i18n",
  );
  if (r.ok && r.data) applyI18n(r.data);
}
