/**
 * Спецклавиши REPL: двойной Esc — аборт прогона, Ctrl+V — вставка картинки,
 * Ctrl+O — допечатка деталей последнего действия.
 *
 * Вынесено из `repl.ts` (правило 6). Хост — узкий вид `Repl`: кадр, агент,
 * канал и отложенная картинка из буфера.
 */
import { pc } from "../ui/colors";
import { LineEditor, type LineInput } from "../ui/line-editor";
import { t } from "../i18n/index";
import { printLastAction } from "./repl-last-action";
import type { Agent } from "../core/agent";
import type { OutputChannel } from "../output";

/** Поля `Repl`, нужные спецклавишам. */
export interface ReplKeysHost {
  lastEscTime: number;
  doubleEscDelay: number;
  agentRunning: boolean;
  pendingClipboardImage: string | null;
  rl: LineInput;
  agent: Agent;
  output: OutputChannel;
}

/** Декодер keypress от LineEditor: поля, которые читает REPL. */
interface SpecialKey {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
}

/** Спецклавиши: двойной Esc — аборт прогона, Ctrl+V — вставка картинки, Ctrl+O — детали. */
export function handleSpecialKey(host: ReplKeysHost, _str: string, rawKey: unknown): boolean {
  const key = (rawKey ?? {}) as SpecialKey;
  if (key.name === "escape") {
    // Декодер keypress Bun схлопывает быстрый двойной Esc в один keypress, чей
    // `sequence` содержит два ESC-байта ("\x1b\x1b"). Подсчёт байтов (не событий)
    // ловит и схлопнутый случай, и два раздельных Esc в окне.
    const escBytes = key.sequence ? (key.sequence.match(/\x1b/g) || []).length : 1;
    const now = Date.now();
    const withinWindow = now - host.lastEscTime < host.doubleEscDelay;
    host.lastEscTime = now;
    if (escBytes >= 2 || withinWindow) {
      host.lastEscTime = 0;
      if (host.agentRunning) {
        host.output.writeLine(pc.yellow(`\n${t("repl.interrupt")}`));
        host.agent.shutdown();
      }
    }
    return true;
  }
  if (key.ctrl && key.name === "v" && !host.agentRunning) {
    pasteClipboardImage(host);
    return true;
  }
  if (key.ctrl && key.name === "o" && !host.agentRunning) {
    reprintLastAction(host);
    return true;
  }
  return false;
}

/** Ctrl+O — допечатка полных деталей последнего действия. */
export function reprintLastAction(host: ReplKeysHost): void {
  printLastAction(host.output);
  if (host.rl instanceof LineEditor) {
    host.rl.reset();
    host.rl.prompt();
  }
}

/** Вставка картинки из буфера обмена (Ctrl+V). */
export async function pasteClipboardImage(host: ReplKeysHost): Promise<void> {
  try {
    const { readClipboardImage, bufferToDataUrl } = await import("../llm/image-utils");
    const clipBuf = await readClipboardImage();
    if (clipBuf) {
      const { dataUrl } = await bufferToDataUrl(clipBuf);
      host.pendingClipboardImage = dataUrl;
      const sizeKb = Math.round((dataUrl.length * 3) / 4 / 1024);
      host.output.writeLine(
        pc.green(`\n${t("image.attached", { source: "clipboard", size: `${sizeKb} KB` })}`),
      );
      if (host.rl instanceof LineEditor) host.rl.reset();
      host.rl.prompt();
    } else {
      host.output.writeLine(pc.yellow(`\n${t("image.clipboard_empty")}`));
      if (host.rl instanceof LineEditor) host.rl.reset();
      host.rl.prompt();
    }
  } catch {
    // Чтение буфера не удалось — игнорим, пусть терминал вставит текст штатно.
  }
}
