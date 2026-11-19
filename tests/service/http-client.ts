/**
 * HTTP-клиент на `node:http` для тестов сервиса.
 *
 * Намеренно НЕ использует `global.fetch`: другие suites (model-loader,
 * openai-compat) перетирают его без восстановления, и в общем прогоне Bun это
 * протекает в последующие файлы. `node:http` изолирован от этой глобальной мутации.
 */
import { request } from "node:http";

export interface TestResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Один HTTP-запрос; JSON-тела передаются строкой. */
export function httpRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: opts.method ?? "GET",
        headers: opts.headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** Запрос с JSON-ответом и JSON-телом запроса. */
export async function httpJson(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; json?: unknown; body?: string } = {},
): Promise<TestResponse & { json: Record<string, unknown> }> {
  const headers = { ...opts.headers };
  let body = opts.body;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  const res = await httpRequest(url, { method: opts.method, headers, body });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { ...res, json };
}
