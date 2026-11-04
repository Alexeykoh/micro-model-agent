/**
 * Команды прогона: `/run` и `/image` (файл, URL, буфер обмена).
 *
 * Вынесено из `repl-commands.ts` (правило 6).
 */
import { pc } from "../ui/colors";
import { t } from "../i18n/index";
import type { ReplContext } from "./repl-commands";

export function registerRunCommands(ctx: ReplContext): void {
  ctx.registerCommand({
    name: "run",
    description: t("repl.run"),
    usage: t("repl.run_usage"),
    action: async (args: string[]) => {
      if (args.length === 0) {
        ctx.output.writeLine(t("repl.run_usage"));
        return;
      }
      const prompt = args.join(" ");
      await ctx.runAgent(prompt);
    },
  });
  ctx.registerCommand({
    name: "image",
    description: t("repl.image"),
    aliases: ["img"],
    usage: t("repl.image_usage"),
    action: async (args: string[]) => {
      const source = args.join(" ");
      if (!source) {
        ctx.output.writeLine(t("repl.image_usage"));
        return;
      }
      try {
        const { loadFileAsDataUrl, loadUrlAsDataUrl, readClipboardImage } =
          await import("../llm/image-utils");
        const { existsSync } = await import("fs");
        const { resolve } = await import("path");

        let dataUrl: string;
        let label: string;

        if (source.toLowerCase() === "clipboard") {
          const clipBuf = await readClipboardImage();
          if (!clipBuf) {
            ctx.output.writeLine(pc.yellow(t("image.clipboard_empty")));
            return;
          }
          const { bufferToDataUrl } = await import("../llm/image-utils");
          const result = await bufferToDataUrl(clipBuf);
          dataUrl = result.dataUrl;
          label = "clipboard";
        } else if (source.startsWith("http://") || source.startsWith("https://")) {
          const result = await loadUrlAsDataUrl(source);
          dataUrl = result.dataUrl;
          label = source;
        } else {
          const absPath = resolve(process.cwd(), source);
          if (!existsSync(absPath)) {
            ctx.output.writeLine(pc.red(t("image.not_found", { path: source })), "stderr");
            return;
          }
          const result = await loadFileAsDataUrl(absPath);
          dataUrl = result.dataUrl;
          label = source;
        }

        const contextManager = ctx.agent.contextManager;
        if (!contextManager) {
          ctx.output.writeLine(pc.red(t("image.no_context")), "stderr");
          return;
        }

        contextManager.addPendingImage({
          type: "image_url",
          image_url: { url: dataUrl },
        });

        const sizeKb = Math.round((dataUrl.length * 3) / 4 / 1024);
        ctx.output.writeLine(
          pc.green(t("image.attached", { source: label, size: `${sizeKb} KB` })),
        );
      } catch (err: unknown) {
        ctx.output.writeLine(
          pc.red(t("image.error", { message: err instanceof Error ? err.message : String(err) })),
          "stderr",
        );
      }
    },
  });
}
