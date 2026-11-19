// REST helper for the `mma web` frontend. The `?token=` query carries auth
// for non-loopback binds (EventSource and fetch share it); same-origin POSTs
// additionally rely on the `mma_web_auth` cookie the server sets.

export const token = new URLSearchParams(location.search).get("token") || "";

export interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
}

export interface ApiOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export async function api<T = unknown>(
  path: string,
  opts: ApiOptions = {},
): Promise<ApiResponse<T>> {
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
