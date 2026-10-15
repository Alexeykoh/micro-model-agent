// Сборка общего `ToolContext` фазы сессий (вынесено из `session-phase.ts`,
// правило ≤300). Живые геттеры (config/sessionId/sessionContext/sessionManager/
// capabilities) — поверх боксов, а не снимки bootstrap.
import { BUILTIN_PROVIDERS } from "../../modules/providers/presets";
import { resolveModelCapabilities } from "../../modules/providers/capabilities";
import type { ContextManager } from "../context/manager";
import type { SessionManager } from "../../modules/session/index";
import type { DraftHost } from "../../modules/plugins/drafts";
import type { AppConfig, ModelCapabilities } from "../../config/types";
import type { Logger } from "../../logger/app-logger";
import type { ToolContext } from "../../tools/types";
import type { Diagnostic } from "../../output/types";

/** Зависимости сборки ToolContext. */
export interface ToolContextInput {
  baseDir: string;
  logger: Logger;
  exitOnComplete: boolean | undefined;
  contextManager: ContextManager;
  activeToolTags: string[];
  sessionManager: SessionManager;
  configRef: { current: AppConfig };
  capabilitiesRef: { probe?: ModelCapabilities };
  draftHost?: DraftHost;
}

/**
 * Sink диагностик fail-open (INV-15): пишет в сессию тем же объектом-записью,
 * что `verify_error`. SessionLogger на момент сборки исполнителя ещё не создан
 * (`Agent.run`), поэтому пишем напрямую через менеджер сессий (как fail-open
 * верификатора в `agent-phase`).
 *
 * Сигнатура по умолчанию выводится из операции; деградация судьи галлюцинаций
 * пишется под своим именем, иначе в разборе сессии два разных отказа
 * выглядели бы как один.
 */

/** Операции проверки заявлений и судьи деградируют под своим именем. */
const OPERATION_SIGNALS: Record<string, "hallucination_judge_degraded"> = {
  "hallucination.judge": "hallucination_judge_degraded",
  "hallucination.evidence": "hallucination_judge_degraded",
};

function signalForOperation(operation: string): "admission_degraded" | "hallucination_judge_degraded" {
  return OPERATION_SIGNALS[operation] ?? "admission_degraded";
}
export function admissionDiagnosticSink(
  sessionManager: SessionManager,
  event?: "admission_degraded" | "hallucination_judge_degraded",
): (diag: Diagnostic) => void {
  return (diag: Diagnostic) => {
    sessionManager.appendLog({
      ts: new Date().toISOString(),
      // Без явного `event` сигнатура выводится из операции: деградация проверки
      // заявлений — не admission, и записывать её под чужим именем значило бы
      // слить два разных отказа в один при разборе сессии.
      type: event ?? signalForOperation(diag.operation),
      content: diag.cause ?? diag.operation,
      source: diag.source,
      operation: diag.operation,
      errorKind: diag.kind,
      cause: diag.cause,
      recoverable: diag.recoverable,
    });
  };
}

/**
 * Собирает `ToolContext` с живыми геттерами поверх `configRef`/менеджера сессий.
 * `llmProvider`/`toolExecutor` выставляются вызывающим после сборки исполнителя.
 */
export function createToolContext(input: ToolContextInput): ToolContext {
  const { baseDir, logger, exitOnComplete, contextManager, activeToolTags } = input;
  const { sessionManager, configRef, capabilitiesRef } = input;

  const toolCtx = {
    baseDir,
    logger,
    exitOnComplete,
    contextManager,
    activeToolTags,
    recursionDepth: 0,
    fileOperationsCount: 0,
    sessionHistory: {
      append: async (type: string, content: unknown) => {
        const meta = sessionManager.getActiveMeta();
        if (!meta) return;
        sessionManager.appendMessage({
          role: "tool",
          content: typeof content === "string" ? content : JSON.stringify(content),
          name: type,
          timestamp: new Date().toISOString(),
        });
      },
    },
    sessionLog: {
      plan: (event: string, detail: string, iteration?: number) => {
        sessionManager.appendLog({
          ts: new Date().toISOString(),
          type: "plan",
          tool: event,
          content: detail,
          ...(iteration !== undefined ? { iteration } : {}),
        });
      },
    },
  } as ToolContext;

  // `config` — ЖИВОЙ геттер поверх общего configRef: тулы и валидаторы видят
  // ТЕКУЩИЕ настройки после reconfigure.
  Object.defineProperty(toolCtx, "config", {
    get: () => configRef.current,
    configurable: true,
  });
  // `sessionId`/`sessionContext` — ЖИВЫЕ геттеры поверх менеджера сессий (аудит,
  // реестр процессов, счётчики файлов видят реально активную сессию).
  Object.defineProperty(toolCtx, "sessionId", {
    get: () => sessionManager.getActiveMeta()?.id,
    configurable: true,
  });
  Object.defineProperty(toolCtx, "sessionContext", {
    get: () => sessionManager.getSessionContext() ?? undefined,
    configurable: true,
  });
  Object.defineProperty(toolCtx, "sessionManager", {
    get: () => sessionManager,
    configurable: true,
  });
  // Возможности активной модели — LIVE: пресет + native-probe + конфиг-оверрайд
  // пересчитываются при каждом обращении.
  Object.defineProperty(toolCtx, "capabilities", {
    get: () => {
      const cfg = configRef.current;
      const spec = BUILTIN_PROVIDERS.find((p) => p.type === cfg.provider.type);
      return resolveModelCapabilities(
        spec?.capabilities,
        capabilitiesRef.probe,
        cfg.modelCapabilities?.[cfg.model],
      );
    },
    configurable: true,
  });

  // Хост черновиков capabilities (`define_capability`) — проектный, ставят и main,
  // и раннеры.
  if (input.draftHost) {
    Object.defineProperty(toolCtx, "pluginDrafts", {
      get: () => input.draftHost,
      configurable: true,
    });
  }

  return toolCtx;
}
