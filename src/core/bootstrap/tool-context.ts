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
import { ApprovalStore } from "../approvals";
import { subagentLogEntry } from "../../tools/subagent-session-log";
import type { Diagnostic, DiagnosticEvent } from "../../output/types";
import { moduleOf } from "../../output";

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

/**
 * Специальные операции: сигнатура не выводится из домена. Всё остальное —
 * по префиксу (ниже). Неизвестная операция больше не маскируется под
 * `admission_degraded`: это скрывало бы домен отказа.
 */
const OPERATION_SIGNALS: Record<string, DiagnosticEvent> = {
  admit: "admission_degraded",
  "hallucination.judge": "hallucination_judge_degraded",
  "hallucination.evidence": "hallucination_judge_degraded",
  "taint.rehydrate": "taint_degraded",
  "tool.execute": "tool_attempt",
  "tool.syntax_precheck": "verify_error",
  "context.compaction": "context_degraded",
  "ssrf.dns": "ssrf_degraded",
};

/** Домен → сигнал: операция несёт место, тип — подсистему (INV-15). */
const OPERATION_PREFIXES: Array<[string, DiagnosticEvent]> = [
  ["provider.", "provider_degraded"],
  ["llm.", "provider_degraded"],
  ["tool.", "tool_degraded"],
  ["session.", "session_degraded"],
  ["mcp.", "module_degraded"],
  ["lsp.", "module_degraded"],
  ["index.", "module_degraded"],
  ["skill.", "module_degraded"],
  ["memory.", "module_degraded"],
  ["browser.", "module_degraded"],
  ["updater.", "module_degraded"],
  ["plan.", "module_degraded"],
  ["webui.", "module_degraded"],
  ["document_", "module_degraded"],
  ["config.", "config_degraded"],
  ["service.", "delivery_degraded"],
  ["plugin.", "hook_degraded"],
  ["context.", "context_degraded"],
];

/** Сигнатура диагностики по операции; неизвестная — `tool_degraded`. */
export function signalForOperation(operation: string): DiagnosticEvent {
  const exact = OPERATION_SIGNALS[operation];
  if (exact) return exact;
  const prefix = OPERATION_PREFIXES.find(([p]) => operation.startsWith(p));
  return prefix?.[1] ?? "tool_degraded";
}
export function admissionDiagnosticSink(
  sessionManager: SessionManager,
  event?: DiagnosticEvent,
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
      module: moduleOf(diag.source),
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
      directive: (event: string, detail: string, iteration?: number) => {
        sessionManager.appendLog({
          ts: new Date().toISOString(),
          type: "directive",
          source: "core",
          tool: event,
          content: detail,
          ...(iteration !== undefined ? { iteration } : {}),
        } as never);
      },
      plan: (event: string, detail: string, iteration?: number) => {
        sessionManager.appendLog({
          ts: new Date().toISOString(),
          type: "plan",
          source: "core",
          tool: event,
          content: detail,
          ...(iteration !== undefined ? { iteration } : {}),
        });
      },
    },
    // Журнал прогонов субагентов: подпоток пишет только факты (старт/тулы/
    // usage/конец) — историю хода пишет родитель (спека
    // `2026-10-27-subagent-run-journal-design`).
    subagentLog: (event) => {
      const entry = subagentLogEntry(event);
      if (entry) sessionManager.appendLog(entry);
    },
    // Одноразовые разрешения `approve`: общее состояние для тула (минтит) и
    // enforcement в `ToolExecutor` (потребляет). Живёт столько же, сколько контекст.
    approvals: new ApprovalStore(),
    // Живая пробы для субагентов: их агент при эксперте-модели получает ту
    // же discovery-решение, что и родитель (INV-R2/INV-R8).
    capabilitiesProbeRef: capabilitiesRef,
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
