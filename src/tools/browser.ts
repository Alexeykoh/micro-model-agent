/** Тул headless-браузера: навигация, клики, ввод, скриншоты (JS-сайты). */
import type { ToolDefinition, ToolContext, ToolResult } from "./types";
import type { ImageUrlPart } from "../llm/provider";
import { BrowserSession } from "../modules/browser/session";
import { DEFAULT_BROWSER_CONFIG } from "../modules/browser/types";
import { bufferToDataUrl } from "../llm/image-utils";
import { t } from "../i18n/index";
import { defaultOutputBus } from "../output";
import { errMsg } from "../utils";
import { join } from "path";
import { mkdirSync } from "fs";
import { projectMmaDir } from "../config/paths";

let session: BrowserSession | null = null;

/**
 * Тестовый seam: подмена фабрики сессии без `vi.mock` (в Bun он глобален на
 * процесс). Используется только в тестах сериализации действий.
 */
let sessionFactory: ((ctx: ToolContext) => BrowserSession) | undefined;

/** @internal */
export function setBrowserSessionFactoryForTest(
  factory?: (ctx: ToolContext) => BrowserSession,
): void {
  sessionFactory = factory;
  session = null;
}

/**
 * Сериализация действий. Параллельные сабагенты делят module-level сессию:
 * одновременный `execute()` перетирает состояние страницы, а `close()` одного
 * субагента убивает сессию остальных. Promise-chain гарантирует, что в браузере
 * одновременно выполняется ровно одно действие.
 */
let actionChain: Promise<unknown> = Promise.resolve();

/** Сериализует действия: одновременно в браузере ровно одно. */
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = actionChain.then(fn, fn);
  actionChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Ленивая module-level сессия (cookie-dir в project .mma). */
function getSession(ctx: ToolContext): BrowserSession {
  if (!session) {
    const cookieDir = join(projectMmaDir(ctx.baseDir), "browser");
    mkdirSync(cookieDir, { recursive: true });
    session = sessionFactory
      ? sessionFactory(ctx)
      : new BrowserSession({
          ...DEFAULT_BROWSER_CONFIG,
          headless: ctx.config.browser?.headless ?? true,
          maxElements: ctx.config.browser?.maxElements ?? 30,
          maxContentChars: ctx.config.browser?.maxContentChars ?? 2500,
          maxConsoleEntries: ctx.config.browser?.maxConsoleEntries ?? 40,
          maxConsoleLineChars: ctx.config.browser?.maxConsoleLineChars ?? 400,
          navigationTimeout: ctx.config.browser?.navigationTimeout ?? 15000,
          viewportWidth: ctx.config.browser?.viewportWidth ?? 1280,
          viewportHeight: ctx.config.browser?.viewportHeight ?? 720,
          cookieDir,
        });
  }
  return session;
}

/** Скриншот для текстовой модели: пометка + текстовый снапшот. */
export function formatScreenshotForTextModel(snapshot: string): string {
  return `${t("tool.screenshot_unavailable")}\n\n${snapshot}`;
}

/**
 * Превращает PNG-буфер скриншота в image-part для доставки модели. Размер
 * ограничивается `bufferToDataUrl` (ресайз ≤800px, JPEG) — иначе base64
 * раздул бы контекст малыша (32K).
 */
export async function screenshotToImagePart(screenshot: Buffer): Promise<ImageUrlPart> {
  const { dataUrl } = await bufferToDataUrl(screenshot);
  return { type: "image_url", image_url: { url: dataUrl } };
}

/** Фабрика browser-тула (сессия ленивая, module-level). */
export function createBrowserTool(): ToolDefinition {
  return {
    name: "browser",
    security: { caps: [{ net: true }], urlArgs: ["url"] },
    icon: "🌐",
    tags: ["browser", "vision"],
    description: [
      "Control a headless browser. Navigate pages, click elements, type text, scroll, take screenshots.",
      "Runs a real browser with JavaScript enabled — use it for JS-rendered sites (weather, dashboards, SPAs) where web_fetch/web_browse return empty content.",
      "Do NOT use it for search queries: search engines (Google, Yandex, Bing) block headless browsers with CAPTCHA/429/redirect pages — use the web_search tool for searching.",
      "Each snapshot returns: a numbered list of interactive elements, the visible page text (Content section), browser console messages, and network errors.",
      "Use the Content section to understand what the page says; use element numbers as targets for click/type.",
      "Without vision capabilities screenshots return only a text note — verify visuals through snapshot text, and for local web UI prefer DOM/API assertions (fetch /api/* endpoints, grep built assets) over driving the browser.",
      "Actions: open (url), click (target), type (target, text), scroll (direction), back, forward, screenshot, snapshot, close, wait (ms).",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "open",
            "click",
            "type",
            "scroll",
            "back",
            "forward",
            "screenshot",
            "snapshot",
            "close",
            "wait",
          ],
          description: "Browser action to perform",
        },
        url: {
          type: "string",
          description: 'URL to open (for action "open")',
        },
        target: {
          type: "number",
          description: 'Element number from snapshot (for action "click" or "type")',
        },
        text: {
          type: "string",
          description: 'Text to type (for action "type")',
        },
        direction: {
          type: "string",
          enum: ["up", "down", "top", "bottom"],
          description: 'Scroll direction (for action "scroll", default "down")',
        },
        ms: {
          type: "number",
          description: 'Milliseconds to wait (for action "wait", default 1000)',
        },
      },
      required: ["action"],
    },
    handler: async (ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> => {
      const action = String(args.action || "");
      if (!action) {
        return { success: false, output: t("tool.action_required") };
      }

      const s = getSession(ctx);
      const result = await serialize(() => s.execute(action, args));

      if (result.screenshot) {
        // Веб-ленте и истории нужен ПОЛНОРАЗМЕРНЫЙ PNG независимо от vision
        // (показ для человека не зависит от возможностей модели) — кладём в
        // `imageFiles`. Модели (только vision-модели) по-прежнему уходит
        // ресайзнутый data URL из `images`; без vision — текстовая пометка.
        const imageFiles = [{ bytes: result.screenshot, mime: "image/png" }];
        if (ctx.capabilities?.vision) {
          return {
            success: result.success,
            output: result.output,
            images: [await screenshotToImagePart(result.screenshot)],
            imageFiles,
          };
        }
        return {
          success: result.success,
          output: formatScreenshotForTextModel(result.output),
          imageFiles,
        };
      }

      return { success: result.success, output: result.output };
    },
  };
}

/** Закрывает сессию после текущего действия (не посреди навигации). */
export function closeBrowserSession(): void {
  const s = session;
  session = null;
  if (!s) return;
  // Дожидаемся текущего действия, чтобы не закрыть браузер во время навигации.
  actionChain = actionChain.then(() =>
    s.close().catch((err) => {
      defaultOutputBus.log("warn", "tool:browser", `Failed to close browser session: ${errMsg(err)}`);
    }),
  );
}
