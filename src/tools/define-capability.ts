// define_capability: агент пишет себе тул.
//
// Ограничения заложены в дизайн, а не в воспитание модели:
// - capability пишется **черновиком** в `.mma/plugins/drafts/` и не выполняется,
//   пока пользователь не разрешит черновики этого проекта;
// - перед первым запуском показывается код целиком и спрашивается согласие;
// - для capability обязательны `permissions` — декларация без единого заявления
//   ничего не значит;
// - никакого eval: файл подхватывается обычным загрузчиком плагинов.
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import type { DraftHost, DraftSpec } from "../modules/plugins/drafts";
import { askUser, type AskUserOptions } from "./user-input";

/** Разрешение на выполнение черновиков: один вопрос с двумя вариантами. */
const CONSENT_OPTIONS: AskUserOptions = {
  options: [
    { label: "allow", description: "draft.captain.allow_hint" },
    { label: "deny", description: "draft.captain.deny_hint" },
  ],
  custom: false,
};

/** Разбор аргументов тула в описание capability (без валидации — она в drafts). */
function readSpec(args: Record<string, unknown>): DraftSpec {
  const permissions = Array.isArray(args.permissions)
    ? args.permissions.filter((p): p is string => typeof p === "string")
    : [];
  const parameters =
    args.parameters && typeof args.parameters === "object"
      ? (args.parameters as Record<string, unknown>)
      : {};
  return {
    name: String(args.name ?? "").trim(),
    description: String(args.description ?? "").trim(),
    parameters,
    code: String(args.code ?? ""),
    permissions,
  };
}

/** Текст вопроса о согласии (тот же, что показывает хост черновиков). */
function consentQuestion(host: DraftHost, spec: DraftSpec): string {
  const preview = host.consentPreview();
  return preview
    ? `${preview}\n\n${t("draft.consent_new", { name: spec.name })}`
    : t("draft.consent_new", { name: spec.name });
}

/**
 * Спросить согласие один раз за сессию хоста: `host.approve()` пишет маркер,
 * повторный вызов тула уже не спрашивает.
 */
async function ensureConsent(
  ctx: Parameters<ToolDefinition["handler"]>[0],
  host: DraftHost,
  spec: DraftSpec,
): Promise<{ approved: boolean }> {
  const answers = await askUser(consentQuestion(host, spec), CONSENT_OPTIONS, ctx.promptIO);
  const approved = answers[0] === "allow";
  if (approved) host.approve();
  return { approved };
}

/** Тул: описать новую capability и записать её черновиком. */
export const defineCapabilityTool: ToolDefinition = {
  name: "define_capability",
  security: { caps: [] },
  icon: "◆",
  description:
    "Define a new tool for yourself: write it as a draft capability in .mma/plugins/drafts/. " +
    "Requires name, description, a JSON schema of arguments (parameters), the handler body " +
    "(code) and declared permissions. " +
    "The handler body is plain statements ending with `return { output: string, success?: boolean }`; " +
    "inside you can use `ctx` (logger, baseDir, config, toolExecutor) and `args` (parsed arguments). " +
    "No imports or top-level code — only the body. The body is syntax-checked; a broken one is rejected. " +
    "The draft does NOT run until the user approves it (you will be asked with the full code shown); " +
    "if it fails to load after approval, you get the error back and the file is discarded. " +
    "Use only when an existing tool cannot do the job.",
  tags: ["meta"],
  // Always-on по той же причине, что и тулы плагинов: блок промпта сообщает
  // модели, что capability можно написать, — и инструмент должен быть в наборе.
  // Иначе при on-demand фильтре модель читала бы про `define_capability` и не
  // видела его в схеме (а сама `enable_tools meta` не вызвала бы).
  alwaysOn: true,
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Capability name (lowercase letters, digits, dot, dash, underscore).",
      },
      description: {
        type: "string",
        description: "What the tool does, 1-2 sentences — shown to the user in the plugins list.",
      },
      parameters: {
        type: "object",
        description: "JSON schema of the tool arguments (type/properties/required).",
      },
      code: {
        type: "string",
        description:
          "Body of the handler: statements that return a result for the call. " +
          "Available: ctx (logger, baseDir, config, toolExecutor), args (parsed arguments).",
      },
      permissions: {
        type: "array",
        items: { type: "string" },
        description:
          "Declared permissions, at least one of: config:read, fs:read, fs:write, process, " +
          "network, session:write. Required — the user sees this list before approving.",
      },
    },
    required: ["name", "description", "parameters", "code", "permissions"],
  },
  handler: async (ctx, args) => {
    const host = ctx.pluginDrafts;
    if (!host) {
      return {
        success: false,
        output: t("draft.capability_unavailable"),
      };
    }
    const spec = readSpec(args);
    const written = host.write(spec);
    if (!written.ok) {
      return { success: false, output: t("draft.capability_invalid", { problem: written.error ?? "" }) };
    }
    // Файл записан, но код ещё не выполняется: спрашиваем явно.
    const { approved } = await ensureConsent(ctx, host, spec);
    if (!approved) {
      return {
        success: true,
        output: t("draft.capability_draft_only", { name: spec.name, path: written.path ?? "" }),
      };
    }
    // Согласие есть — подхватываем живым reload (кэш модулей сбрасывается).
    const report = host.reloadDrafts();
    if (report.failed > 0) {
      // Не оставляем заведомо битый одобренный черновик: забираем причину у
      // загрузчика, откатываем файл и отдаём модели текст ошибки для починки.
      const error = host.lastError(spec.name) ?? "unknown load error";
      host.remove(spec.name);
      return {
        success: false,
        output: t("draft.capability_load_failed", { name: spec.name, error }),
        errorMeta: {
          code: "draft_load_failed",
          retryable: true,
          hint: "Fix the handler body and call define_capability again with the same name.",
        },
      };
    }
    return {
      success: true,
      output: t("draft.capability_created", {
        name: spec.name,
        loaded: String(report.loaded),
        failed: String(report.failed),
      }),
    };
  },
};
