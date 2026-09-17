import { createRequire } from "module";
import readline from "readline";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const CONSOLE_CAP = 500;
const NETWORK_CAP = 100;
let maxLineChars = 400;

let browser = null;
let context = null;
let page = null;
let consoleBuf = [];
let networkBuf = [];
let lastUrl = "";

function pushConsole(type, text) {
  if (consoleBuf.length >= CONSOLE_CAP) return;
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (!clean) return;
  const line = clean.length > maxLineChars ? clean.slice(0, maxLineChars) + "…" : clean;
  consoleBuf.push({ type, text: line });
}

function pushNetwork(err) {
  if (networkBuf.length >= NETWORK_CAP) return;
  networkBuf.push(err);
}

function drain() {
  const consoleEvents = consoleBuf;
  const networkEvents = networkBuf;
  consoleBuf = [];
  networkBuf = [];
  return { console: consoleEvents, network: networkEvents };
}

function readInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// System browsers to try when the bundled Chromium revision is absent (CDN
// blocked / offline). Mirrors driver.ts so both transports behave the same.
const SYSTEM_CHANNEL_FALLBACKS = ["chrome", "msedge"];

function isMissingBrowserError(err) {
  return /Executable doesn't exist|is not found|looks like Playwright was just installed/i.test(
    String(err && err.message ? err.message : err),
  );
}

async function launchChromium(params, extra) {
  const base = {
    headless: params?.headless !== false,
    timeout: readInt(params?.timeoutMs, 30000),
    ...extra,
  };
  try {
    return await chromium.launch(base);
  } catch (err) {
    // An explicit executable/channel is the user's choice — fail loudly.
    if (base.executablePath || base.channel || !isMissingBrowserError(err)) throw err;
    let lastErr = err;
    for (const channel of SYSTEM_CHANNEL_FALLBACKS) {
      try {
        return await chromium.launch({ ...base, channel });
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }
}

async function handleLaunch(params) {
  if (browser) return { ok: true };
  maxLineChars = readInt(params?.maxConsoleLineChars, 400);
  const extra = {};
  if (params?.executablePath) extra.executablePath = String(params.executablePath);
  if (params?.channel) extra.channel = String(params.channel);
  browser = await launchChromium(params, extra);
  context = await browser.newContext({
    viewport: params?.viewport || { width: 1280, height: 720 },
  });
  page = await context.newPage();
  page.setDefaultTimeout(readInt(params?.timeoutMs, 30000));

  page.on("console", (msg) => pushConsole(msg.type(), msg.text()));
  page.on("pageerror", (err) => pushConsole("pageerror", `Page error: ${err.message}`));
  page.on("requestfailed", (req) => {
    const failure = req.failure();
    pushNetwork({ method: req.method(), url: req.url(), error: failure?.errorText || "unknown" });
  });

  return { ok: true };
}

async function handleGoto(params) {
  if (!page) return { ok: false, error: "No page open" };
  const url = String(params?.url || "");
  const timeoutMs = readInt(params?.timeoutMs, 15000);
  consoleBuf = [];
  networkBuf = [];
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    lastUrl = page.url();
    return { ok: true, data: { url: lastUrl } };
  } catch (err) {
    lastUrl = page.url();
    return { ok: false, error: err.message, data: { url: lastUrl } };
  }
}

async function handleEvaluate(params) {
  if (!page) return { ok: false, error: "No page open" };
  const js = String(params?.js || "");
  try {
    const result = await page.evaluate(js);
    return { ok: true, data: { result } };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function handleClose() {
  try {
    if (page) await page.close();
  } catch {}
  try {
    if (context) await context.close();
  } catch {}
  try {
    if (browser) await browser.close();
  } catch {}
  page = null;
  context = null;
  browser = null;
  return { ok: true };
}

const handlers = {
  ping: async () => ({ ok: true, data: { pong: true, runtime: process.version } }),
  launch: handleLaunch,
  goto: handleGoto,
  evaluate: handleEvaluate,
  content: async () => ({ ok: true, data: { html: page ? await page.content() : "" } }),
  title: async () => ({ ok: true, data: { title: page ? await page.title() : "" } }),
  url: async () => ({ ok: true, data: { url: page ? page.url() : lastUrl } }),
  waitLoad: async (params) => {
    if (!page) return { ok: false, error: "No page open" };
    try {
      await page.waitForLoadState("domcontentloaded", {
        timeout: readInt(params?.timeoutMs, 15000),
      });
    } catch {}
    return { ok: true };
  },
  screenshot: async () => {
    if (!page) return { ok: false, error: "No page open" };
    try {
      const buf = await page.screenshot({ type: "png", fullPage: false });
      return { ok: true, data: { base64: buf.toString("base64") } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
  cookies: async () => {
    if (!context) return { ok: true, data: { cookies: [] } };
    const cookies = await context.cookies();
    return { ok: true, data: { cookies } };
  },
  setCookies: async (params) => {
    if (!context) return { ok: false, error: "No context" };
    const cookies = Array.isArray(params?.cookies) ? params.cookies : [];
    if (cookies.length > 0) {
      try {
        await context.addCookies(cookies);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    return { ok: true };
  },
  back: async (params) => {
    if (!page) return { ok: false, error: "No page open" };
    try {
      await page.goBack({
        waitUntil: "domcontentloaded",
        timeout: readInt(params?.timeoutMs, 15000),
      });
    } catch {}
    lastUrl = page.url();
    return { ok: true, data: { url: lastUrl } };
  },
  forward: async (params) => {
    if (!page) return { ok: false, error: "No page open" };
    try {
      await page.goForward({
        waitUntil: "domcontentloaded",
        timeout: readInt(params?.timeoutMs, 15000),
      });
    } catch {}
    lastUrl = page.url();
    return { ok: true, data: { url: lastUrl } };
  },
  close: handleClose,
};

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const handler = handlers[req.cmd];
  let resp;
  if (!handler) {
    resp = { id: req.id, ok: false, error: `Unknown command: ${req.cmd}`, ...drain() };
  } else {
    try {
      const result = await handler(req.params || {});
      resp = { id: req.id, ...result, ...drain() };
    } catch (err) {
      resp = { id: req.id, ok: false, error: err.message, ...drain() };
    }
  }
  process.stdout.write(JSON.stringify(resp) + "\n");
});

let shuttingDown = false;
async function shutdown() {
  // Idempotent: signals, stdin close and the explicit close command may race.
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await handleClose();
  } catch (err) {
    // Best-effort cleanup: never block process exit on a broken browser.
    console.error("[bridge-server] cleanup during shutdown failed:", err);
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
// Parent died without sending "close" (crash, kill -9): stdin EOF is the
// last signal we get — without this the bridge and its Chromium leak.
rl.on("close", () => void shutdown());
