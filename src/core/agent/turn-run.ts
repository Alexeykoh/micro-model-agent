/**
 * Координатор хода агента (`TurnCoordinator`, INV-23): старт/сброс состояния,
 * авто-сужение тегов, старт сессии, запись пользовательского хода и автонейминг,
 * жизненный цикл `onTurnEnd`, вызов единственного пути `executeSingleAgentLoop`.
 *
 * Вынесено из `core/agent.ts`; работает над `TurnRunHost` — видом `Agent`.
 */
import type { AgentDeps } from "../agent";
import type { AgentPhase, AgentResult, OnMeta, ToolEvent } from "../types";
import type { SessionLogger } from "../session-logger";
import { SessionLogger as SessionLoggerCtor } from "../session-logger";
import { seedToolTags } from "../../tools/auto-tags";
import { deriveSessionName, generateSessionTitle, type TitleChat } from "../../modules/session/auto-name";
import { ensureSessionStart } from "./session-start";import type { SystemPromptBuild } from "./prompt-phase";

/** Мутабельный вид `Agent`, которым владеет координатор хода. */
export interface TurnRunHost {
  deps: AgentDeps;
  shutdownRequested: boolean;
  abortController: AbortController | null;
  systemPromptAdded: boolean;
  overflowResolved: boolean;
  probePassed: boolean;
  setScope(): void;
  buildSystemPrompt(): SystemPromptBuild;
  resolvePromptOverflowOnce(): Promise<void>;
  callerProvenance(): { provider: string; model: string };
  executeSingleAgentLoop(
    input: string,
    slog: SessionLogger,
    onChunk?: (chunk: string) => void,
    onMeta?: OnMeta,
    onTool?: (ev: ToolEvent) => void,
    onPhase?: (phase: AgentPhase) => void,
    onReasoning?: (reasoning: string) => void,
  ): Promise<AgentResult>;
}

/** Прогоняет один ход агента (единый путь исполнения). */
export async function runTurn(
  host: TurnRunHost,
  input: string,
  onChunk?: (chunk: string) => void,
  onMeta?: OnMeta,
  onTool?: (ev: ToolEvent) => void,
  onPhase?: (phase: AgentPhase) => void,
  onReasoning?: (reasoning: string) => void,
): Promise<AgentResult> {
  const { deps } = host;
  // Сброс флага shutdown от прошлого прерывания; свежий контроллер на ход.
  host.shutdownRequested = false;
  host.abortController = new AbortController();
  host.setScope();
  // P5 автосужение: детерминированно пред-посеваем теги тулов из сырого
  // сообщения ДО первого LLM-вызова. Только добавление — mid-session гранты
  // enable_tools не снимаются. Пропуск при enableOnDemand: false.
  if (deps.config.tools?.enableOnDemand !== false && deps.toolTags) {
    const added = seedToolTags(deps.toolTags, input);
    if (added.length > 0) {
      deps.logger.debug(`Auto-narrowing: pre-seeded tool tags [${added.join(", ")}]`);
    }
  }
  const { config, llmProvider, pluginManager, contextManager, logger, sessionManager } = deps;

  const slog = new SessionLoggerCtor(sessionManager, logger, () => host.callerProvenance());

  if (sessionManager && !sessionManager.getActive()) {
    sessionManager.create();
    logger.debug(`Session started: ${sessionManager.getActive()}`);
  }

  const activeMeta = sessionManager?.getActiveMeta();
  const isFirstMessage = !!activeMeta && activeMeta.messageCount === 0;

  const start = await ensureSessionStart(
    {
      deps,
      systemPromptAdded: host.systemPromptAdded,
      overflowResolved: host.overflowResolved,
      buildSystemPrompt: () => host.buildSystemPrompt(),
      resolvePromptOverflowOnce: () => host.resolvePromptOverflowOnce(),
    },
    slog,
  );
  if (start) {
    host.systemPromptAdded = start.systemPromptAdded;
    host.overflowResolved = start.overflowResolved;
    if (start.probePassed !== undefined) host.probePassed = start.probePassed;
  }

  // Новое сообщение — новый интервал компакции: итерации прошлого хода не должны
  // триггерить компакцию на итерации 1 этого.
  if (typeof contextManager.resetUserTurn === "function") {
    contextManager.resetUserTurn();
  }
  // Пользовательские картинки (web/one-shot) персистим до аттача к сообщению,
  // чтобы `/resume`/reload восстановил их в ленте.
  const pendingImages =
    typeof contextManager.getPendingImages === "function" ? contextManager.getPendingImages() : [];
  contextManager.addMessage({ role: "user", content: input });
  const userImageRefs = pendingImages.length
    ? slog.persistUserImages(
        pendingImages.flatMap((p) =>
          p.type === "image_url" && p.image_url.url ? [p.image_url.url] : [],
        ),
        {
          maxCount: config.images?.maxCount ?? 30,
          maxBytes: config.images?.maxBytes ?? 104_857_600,
        },
      )
    : undefined;
  slog.logUser(input, userImageRefs);

  if (isFirstMessage && activeMeta && sessionManager) {
    const meta = sessionManager.getActiveMeta();
    if (meta && (meta.nameSource ?? "default") !== "manual") {
      sessionManager.rename(meta.id, deriveSessionName(input), "auto");
      if (config.session.autoName !== false) {
        const chat: TitleChat = async (prompt, signal) => {
          let text = "";
          for await (const chunk of llmProvider.chat([{ role: "user", content: prompt }], undefined, signal, {
            maxTokens: 48,
            reasoningEffort: "none",
            sessionId: meta?.id,
          })) {
            if (chunk.type === "text" && chunk.content) text += chunk.content;
          }
          return text;
        };
        void generateSessionTitle(input, chat)
          .then((title) => {
            if (!title) return;
            const cur = sessionManager.getActiveMeta();
            if (cur && cur.id === meta.id && (cur.nameSource ?? "default") === "auto") {
              sessionManager.rename(meta.id, title, "auto");
            }
          })
          .catch(() => {});
      }
    }
  }

  // Жизненный цикл хода для плагинов: считаем тул-события вне цикла,
  // onTurnEnd — ровно один раз (успех, ошибка или прерывание).
  const startedAt = Date.now();
  let toolCalls = 0;
  const countTool = (ev: ToolEvent) => {
    if (ev.type === "end") toolCalls++;
    onTool?.(ev);
  };
  const emitTurnEnd = (result: AgentResult | null, err?: unknown) => {
    const interrupted =
      (err instanceof Error && err.name === "AbortError") || host.shutdownRequested;
    // `meta.updatedAt` двигает в основном appendMessage. Ход без сообщений
    // оставлял мету со временем старта — список показывал «сессию, которой нет».
    if (sessionManager) sessionManager.touch?.();
    pluginManager.runOnTurnEnd?.(
      { logger, sessionManager: sessionManager?.getActiveMeta(), contextManager },
      {
        success: !!result && result.success !== false && !err,
        durationMs: Date.now() - startedAt,
        textLength: (result?.text || "").length,
        toolCalls,
        interrupted: interrupted || undefined,
      },
    );
  };

  try {
    // Единственный путь выполнения хода (INV-22): гейты нельзя обойти сменой
    // пути. Параллельные сабагенты — через `parallelizable` на туле subagent.
    const result = await host.executeSingleAgentLoop(
      input,
      slog,
      onChunk,
      onMeta,
      countTool,
      onPhase,
      onReasoning,
    );
    const provenance = host.callerProvenance();
    result.provider = provenance.provider;
    result.model = provenance.model;
    result.durationMs = Date.now() - startedAt;
    emitTurnEnd(result);
    return result;
  } catch (err) {
    emitTurnEnd(null, err);
    throw err;
  }
}
