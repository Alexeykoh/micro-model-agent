// REST helper for the `mma web` frontend. The `?token=` query carries auth
// for non-loopback binds (EventSource and fetch share it); same-origin POSTs
// additionally rely on the `mma_web_auth` cookie the server sets.

export const token = new URLSearchParams(location.search).get("token") || "";

export async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["x-mma-token"] = token;
  let res;
  try {
    res = await fetch(path, {
      method: opts.method || "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    return { ok: false, status: 0, data: null };
  }
  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}
