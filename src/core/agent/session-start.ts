/**
 * Фаза старта сессии (`TurnCoordinator`, INV-23): первая запись `session_start`
 * в лог, ленивые промпт-блоки, одноразовый резолв переполнения, фоновая
 * reasoning-проба и добавление системного сообщения с `onSessionStart`.
 *
 * Вынесено из `core/agent.ts`; функция не держит мутабельного состояния, а
 * возвращает новые значения флагов, которые координатор присваивает себе.
 */
import type { AgentDeps } from "../agent";
import type { SessionLogger } from "../session-logger";
import type { SystemPromptBuild } from "./prompt-phase";
import { t } from "../../i18n/index";

/** Входные данные фазы (снимок текущих флагов агента). */
export interface SessionStartInput {
  deps: AgentDeps;
  systemPromptAdded: boolean;
  overflowResolved: boolean;
  buildSystemPrompt(): SystemPromptBuild;
  resolvePromptOverflowOnce(): Promise<void>;
  /** Пересборка системного сообщения в живом контексте (resume-путь, B11). */
  refreshSystemPrompt(): void;
}

/** Итог фазы: новые значения флагов (null — старт уже был, менять нечего). */
export interface SessionStartResult {
  systemPromptAdded: boolean;
  overflowResolved: boolean;
  /** `undefined` — проба не задана (флаг не трогаем). */
  probePassed?: boolean;
}

/**
 * Ленивые блоки — в общий набор один раз (идемпотентно по идентичности:
 * `makeLazyPromptBlocks` мемоизирует объект, повторный push дал бы дубль
 * health-check блока в промпте). Один путь для старта и resume (B11).
 */
async function ensureLazyBlocks(deps: AgentDeps): Promise<void> {
  const lazy = deps.lazyPromptBlocks ? await deps.lazyPromptBlocks() : [];
  for (const block of lazy) {
    if (!deps.promptBlocks.includes(block)) deps.promptBlocks.push(block);
  }
}

/**
 * Если сессия ещё не инициализирована (нет системного сообщения), пишет
 * `session_start`, дожидается ленивых блоков/пробы и добавляет системный
 * промпт. Возвращает null при уже добавленном промпте — EXCEPT resume (B11):
 * свежий агент после `setContext` (раннеры, `/resume`) несёт system, но
 * kind-overflow ни разу не резолвил — догоняем резолв + refresh, иначе
 * инструкции/карта сверх бюджета молча выкидывались бы каждой сборкой.
 */
export async function ensureSessionStart(
  input: SessionStartInput,
  slog: SessionLogger,
): Promise<SessionStartResult | null> {
  const { deps } = input;
  const { contextManager, logger, pluginManager, sessionManager } = deps;
  if (
    input.systemPromptAdded ||
    contextManager.getActiveHistory().some((m) => m.role === "system")
  ) {
    if (!input.overflowResolved) {
      await ensureLazyBlocks(deps);
      try {
        await input.resolvePromptOverflowOnce();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.logger.warn(t("prompt.overflow.failed", { error: message }));
      }
      input.refreshSystemPrompt();
      return { systemPromptAdded: true, overflowResolved: true };
    }
    return null;
  }

  // Стартовую диагностику сессии (окружение, плагины, скиллы) — первой записью
  // в session.jsonl, чтобы файл был самоописываем. Провайдер-срез берём из
  // ЖИВОГО конфига, а не из bootstrap-снимка envReport (фоновая context-probe
  // приземляется позже и снимок показывал до-пробное окно).
  const env = deps.envReport;
  const liveProvider = env?.provider
    ? { ...env.provider, model: deps.config.model, contextWindow: deps.config.contextWindow }
    : undefined;
  slog.logSessionStart({
    environment: { ...((env ?? {}) as Record<string, unknown>), provider: liveProvider },
  });

  await ensureLazyBlocks(deps);

  // Одноразовый резолв instructions/project-map сверх бюджета ДО первой сборки.
  let overflowResolved = input.overflowResolved;
  if (!overflowResolved) {
    overflowResolved = true;
    try {
      await input.resolvePromptOverflowOnce();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.warn(t("prompt.overflow.failed", { error: message }));
    }
  }

  // B2: ждём фоновую reasoning-пробу рядом с ленивыми блоками, чтобы ПЕРВЫЙ
  // LLM-вызов уже знал, держит ли бэкенд механизм.
  let probePassed: boolean | undefined;
  if (deps.reasoningProbe) {
    probePassed = await deps.reasoningProbe();
  }

  const { prompt: systemPrompt, excluded } = input.buildSystemPrompt();
  contextManager.addMessage({ role: "system", content: systemPrompt });
  slog.logSystem(systemPrompt.slice(0, 2000));
  if (excluded.length > 0) {
    slog.logSystem(`[Excluded prompt blocks: ${excluded.length}]`);
  }
  pluginManager.runOnSessionStart({
    logger,
    sessionManager: sessionManager?.getActiveMeta(),
    contextManager,
  });

  return { systemPromptAdded: true, overflowResolved, probePassed };
}
