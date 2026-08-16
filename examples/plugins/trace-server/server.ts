/**
 * HTTP + SSE server for the trace-server plugin.
 *
 * Transport is SSE over node:http — works under both Bun and the Node dist.
 * The frontend page is read from disk at startup and served verbatim (never
 * template-processed), so escape sequences inside the page's <script> stay
 * literal.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { exec } from "node:child_process";
import { state, flush, HOST, MAX_CLIENTS } from "./state";
import { readPlans } from "./plans";
import { stopPlanPolling } from "./plans";

export function handleRequest(req: IncomingMessage, res: ServerResponse, html: string): void {
  const reqUrl = new URL(req.url || "/", `http://${HOST}`);
  if (reqUrl.pathname === "/events") {
    if (state.clients.size >= MAX_CLIENTS) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Too many trace clients");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 1200\n\n");
    res.write(
      `event: session\ndata: ${JSON.stringify({ session: state.sessionMeta, url: state.traceUrl, connectedAt: Date.now() })}\n\n`,
    );
    // Fresh page: push the current context text + plan snapshot so the right
    // panel is populated immediately instead of waiting for the next event.
    if (state.contextText) {
      res.write(
        `event: context_text\ndata: ${JSON.stringify({
          ts: Date.now(),
          text: state.contextText,
          iteration: undefined,
          tokens: state.lastContext?.tokens ?? 0,
          quality: state.lastContext?.quality ?? 0,
          messageCount: state.lastContext?.messageCount ?? 0,
        })}\n\n`,
      );
    }
    const plans = readPlans();
    if (plans.active || plans.drafts.length || plans.archived.length) {
      res.write(
        `event: plans\ndata: ${JSON.stringify({
          ts: Date.now(),
          active: plans.active,
          drafts: plans.drafts,
          archived: plans.archived,
          history: state.planHistory.slice(0, 100),
        })}\n\n`,
      );
    }
    state.clients.add(res);
    const hb = setInterval(() => {
      try {
        res.write(`: hb ${Date.now()}\n\n`);
      } catch {
        clearInterval(hb);
      }
    }, 15_000);
    req.on("close", () => {
      clearInterval(hb);
      state.clients.delete(res);
    });
    return;
  }
  if (reqUrl.pathname === "/" || reqUrl.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

export function startServer(html: string): Promise<string> {
  if (state.server) return Promise.resolve(state.traceUrl);
  if (state.starting) return state.starting;
  const desired = Number(process.env.MMA_TRACE_PORT) || 0;
  state.starting = new Promise<string>((resolve, reject) => {
    const attempt = (port: number, left: number) => {
      const srv = createServer((req, res) => handleRequest(req, res, html));
      srv.on("error", (err: NodeJS.ErrnoException) => {
        if (port !== 0 && left > 0 && err.code === "EADDRINUSE") attempt(port + 1, left - 1);
        else {
          state.starting = null;
          reject(err);
        }
      });
      srv.listen(port, HOST, () => {
        state.server = srv;
        const addr = srv.address();
        const p = typeof addr === "object" && addr ? addr.port : port;
        state.traceUrl = `http://${HOST}:${p}`;
        state.starting = null;
        resolve(state.traceUrl);
      });
    };
    attempt(desired, 10);
  });
  return state.starting;
}

export function stopServer(): void {
  flush();
  stopPlanPolling();
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  for (const client of state.clients) {
    try {
      client.end();
    } catch {
      /* ignore */
    }
  }
  state.clients.clear();
  if (state.server) {
    try {
      state.server.close();
    } catch {
      /* ignore */
    }
    state.server = null;
  }
  state.starting = null;
  state.sessionMeta = null;
}

export function tryOpenBrowser(url: string): void {
  if (process.env.MMA_TRACE_OPEN === "0") return;
  try {
    const platform = process.platform;
    const cmd =
      platform === "win32"
        ? `start "" "${url}"`
        : platform === "darwin"
          ? `open "${url}"`
          : `xdg-open "${url}"`;
    const child = exec(cmd, { windowsHide: true });
    child.unref?.();
  } catch {
    /* best-effort */
  }
}