/**
 * Тул `document_read`: срез документа по селектору (INV-D5 — fail-open с
 * причиной; INV-D7 — декларация `security` обязательна).
 *
 * Особый случай — растровое изображение (W4): если у активной модели есть
 * vision и доступен `contextManager`, картинка уходит в `ToolResult.images`
 * (data URL), а не строкой в тексте. Иначе — честный fail-open
 * (`documents.needs_vision`), а не пустой успех.
 */
import { t } from "../../../i18n/index";
import type { ToolDefinition, ToolResult } from "../../../tools/types";
import { buildDataUrl, MAX_VISION_BYTES, rasterMime } from "../media";
import { parseSelector, renderDocumentRead, type ReadOutcome } from "../read";
import { parseCtx, type DocumentRegistry } from "../registry";
import { fileSource } from "../source";
import { causeOf, failResult, rejectResult } from "./run";

/** Отказ рендера (`section` не найден / неизвестный селектор) → причина для модели. */
function failureMessage(outcome: Extract<ReadOutcome, { ok: false }>): string {
  if (outcome.kind === "unknown-selector") {
    return t("documents.selector_unknown", { selector: outcome.arg });
  }
  const available = outcome.available.length
    ? outcome.available.join(", ")
    : t("documents.section_none");
  return t("documents.section_not_found", { title: outcome.arg, available });
}

/** Тул `document_read`: срез по селектору (all/section/blocks) либо vision-растр. */
export function documentReadTool(registry: DocumentRegistry): ToolDefinition {
  return {
    name: "document_read",
    security: { caps: [{ fs: "read" }], pathArgs: ["path"] },
    icon: "📄",
    tags: ["document", "file"],
    boundedOutput: true,
    cacheable: true,
    description: t("documents.read_desc"),
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: t("documents.path_desc") },
        selector: { type: "string", description: t("documents.selector_desc") },
      },
      required: ["path"],
    },
    handler: async (ctx, args): Promise<ToolResult> => {
      try {
        const selector = parseSelector(String(args.selector ?? "all"));
        const source = fileSource(ctx.baseDir, String(args.path ?? ""));
        const ir = await registry.parse(parseCtx(ctx.logger), source);

        const mime = rasterMime(ir);
        if (mime) {
          // Для растровых изображений `selector` не применяется: картинка
          // передаётся целиком, срезы по разделам/блокам к ней неприменимы.
          if (ctx.capabilities?.vision === true && ctx.contextManager) {
            const bytes = await source.bytes();
            if (bytes.length > MAX_VISION_BYTES) {
              const limit = `${Math.round(MAX_VISION_BYTES / (1024 * 1024))} MiB`;
              return rejectResult(
                ctx,
                "document_read",
                "raster image exceeds vision byte cap",
                t("documents.image_too_large", { path: source.display, limit }),
              );
            }
            return {
              success: true,
              output: t("documents.image_attached"),
              images: [{ type: "image_url", image_url: { url: buildDataUrl(bytes, mime) } }],
            };
          }
          return rejectResult(
            ctx,
            "document_read",
            "vision unavailable for raster image",
            t("documents.needs_vision", { path: source.display }),
          );
        }

        const outcome = renderDocumentRead(ir, selector);
        if (!outcome.ok) throw new Error(failureMessage(outcome));
        return { success: true, output: outcome.text };
      } catch (err) {
        return failResult(ctx, "document_read", causeOf(err));
      }
    },
  };
}
