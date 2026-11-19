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
  /**
   * Отпечаток входов последнего резолва (B16/B17); null/undefined — сверить
   * заново (первый прогон, апгрейд со старого агента).
   */
  overflowFingerprint?: string | null;
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
  /** Отпечаток после (пере)резолва; `undefined` — не менялся. */
  overflowFingerprint?: string;
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
 * промпт. Дальше — ревалидация резолва (B16/B17): отпечаток входов
 * (бюджет + kind-блоки) сверяется каждый прогон; изменился контент инструкций
 * или сузился бюджет — резолв повторяется, иначе пропускается дёшево.
 * Resume-путь (B11): свежий агент после `setContext` несёт system, но резолв
 * ни разу не видел — догоняем резолв + refresh вместо молчаливой потери.
 */
export async function ensureSessionStart(
  input: SessionStartInput,
  slog: SessionLogger,
): Promise<SessionStartResult | null> {
  const { deps } = input;
  const { contextManager, logger, pluginManager, sessionManager } = deps;
  const started =
    input.systemPromptAdded ||
    contextManager.getActiveHistory().some((m) => m.role === "system");

  if (!started) {
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
  }

  // Отпечаток текущих входов резолва (B16/B17). Повторный резолв — только при
  // расхождении: правка AGENTS.md/карты или смена бюджета между прогонами.
  // Ленивые блоки подтягиваем только перед резолвом (они входят в бюджет):
  // дёргать фоновую проверку каждый прогон — лишний await и лишний слот.
  const dry = input.buildSystemPrompt();
  let overflowResolved = input.overflowResolved;
  let overflowFingerprint = input.overflowFingerprint ?? undefined;
  const shouldResolve = !overflowResolved || overflowFingerprint !== dry.fingerprint;
  if (shouldResolve) {
    await ensureLazyBlocks(deps);
    overflowResolved = true;
    overflowFingerprint = dry.fingerprint;
    try {
      await input.resolvePromptOverflowOnce();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.warn(t("prompt.overflow.failed", { error: message }));
    }
  }

  if (!started) {
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

    return { systemPromptAdded: true, overflowResolved, probePassed, overflowFingerprint };
  }

  if (shouldResolve) {
    input.refreshSystemPrompt();
    return { systemPromptAdded: true, overflowResolved, overflowFingerprint };
  }
  return null;
}
