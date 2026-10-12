// Execution-модуль: трекер плана, stuck-детектор, аудитор, гейты, автопоиск ошибок.
import type { AgentModule } from "../types";
import type { PromptBlock } from "../../core/types";
import type { ToolDefinition, ToolContext, ToolCall } from "../../tools/types";
import type { AgentPlugin } from "../types";
import { t } from "../../i18n/index";
import { PlanTracker } from "./tracker";
import { StepVerifier } from "./verifier";
import { StuckDetector, isSearchableError, buildSearchQuery } from "./stuck-detector";
import { Auditor, findExistingFile } from "./auditor";
import { PlanStore } from "./plan-store";
import { getMessageText } from "../../llm/provider";
import type { ContentPart } from "../../llm/provider";
import type { Plan, StepKind } from "./planner";
import { extractFileLikeTokens, stripUrls } from "../../core/hallucination/js-identifiers";
import { toForwardSlash } from "../../tools/path-utils";
import { readFileSync } from "fs";
import type { NetworkSecurityConfig } from "../../config/types";
import { performWebSearch, type SearchResult } from "../../tools/web-search";
import { getSessionSecurityConfig } from "../security/session-isolation";
import { createPlanToolDefinitions } from "./plan-tool";
import { isValidCheck } from "./plan-checks";
import {
  createExecutionPlugin,
  STUCK_RECOVERY_COOLDOWN,
  STUCK_WARN_REPEAT_EVERY,
  type ExecutionPluginState,
} from "./execution-plugin";
import { EXECUTION_ERROR_SEARCH_MIN_INTERVAL_MS as ERROR_SEARCH_MIN_INTERVAL_MS } from "../../config/timeouts";
import { advancePlanIfStepComplete, provablyStale, type StepAdvanceDeps } from "./step-advance";
import type { Diagnostic } from "../../output/types";

/** Реэкспорт для потребителей (тесты): реализация — в `step-advance.ts`. */
export { provablyStale } from "./step-advance";

/**
 * Инжектированный раннер поиска. По умолчанию performWebSearch (общий с тулом
 * web_search), чтобы тесты подменяли моком. `requestTimeoutMs` переопределяет
 * сетевой таймаут (errorWebSearch.requestTimeoutMs).
 */
export type WebSearchRunner = (
  query: string,
  numResults: number,
  networkConfig: NetworkSecurityConfig | undefined,
  requestTimeoutMs?: number,
) => Promise<{ success: boolean; results: SearchResult[]; error?: string; blocked?: boolean }>;

/**
 * Минимальный интервал между автопоисками ошибок. Спек просил кап
 * STUCK_RECOVERY_COOLDOWN-итераций, но в onAfterTool нет счётчика итераций
 * (контекст экзекутора) — та же анти-спам защита, но по времени. Инжектится
 * через конструктор для тестов (0 отключает).
  */

/**
 * Тулы, которым можно при активном шаге плана БЕЗ проверки step-alignment.
 * Либо не трогают ФС, либо структурно/read-only инспекции, нужные агенту в
 * любой точке (диагностика, индекс/поиск, память, интроспекция процессов,
 * интерактивные промпты). К текущему шагу пинятся только файл-мутирующие.
 *
 * `lsp_check` и `project_map` здесь явно: оба alwaysOn, а системный промпт
 * ТРЕБУЕТ `lsp_check` после каждой записи (включая переписи файлов уже
 * закрытых шагов). Без них каждый диагностический вызов жёг plan-warning и мог
 * hard-block'нуть легитимную запись на 3-м вызове (было: "3 вызовов подряд вне
 * текущего шага", пока агент писал deliverable текущего же шага).
 */
const PLAN_ALIGNMENT_EXEMPT_TOOLS = new Set([
  // structural / execution control
  "plan",
  "plan_step",
  "todo",
  "verify",
  "enable_tools",
  // filesystem reads
  "list_dir",
  "read_file",
  "glob",
  "grep",
  "file_info",
  // read-only diagnostics + code index
  "lsp_check",
  "project_map",
  "chunk_query",
  // web / memory / session reads
  "web_search",
  "web_fetch",
  "web_browse",
  "recall",
  "search_history",
  "session_info",
  // process introspection
  "process_list",
  "process_log",
  // interactive prompts (no filesystem mutation)
  "question",
  "approve",
  // skills
  "load_skill",
]);

/**
 * Каноническая форма файлового токена для alignment: прямые слэши + lowercase.
 * Вызовы тулов несут абсолютные Windows-пути (`C:\…\test\src\main.ts`), а шаги
 * плана — относительные (`src/main.ts`); сравнение сырых строк делало каждый
 * on-track write off-path (бэкслэш vs прямой слэш не пересекаются).
 * Нормализация обеих сторон чинит overlap через substring/`endsWith` ниже.
 */
function planPathToken(p: string): string {
  return toForwardSlash(p).toLowerCase();
}


/** Execution-модуль: план, stuck-детектор, аудитор, гейты выравнивания и автопоиск ошибок. */
export class ExecutionModule implements AgentModule {
  name = "execution";
  private tracker: PlanTracker | null = null;
  /** Сессия-владелец текущего трекера. План следует за сессией: смена
   *  сессии через switchSession() персистит трекер в слот старой сессии
   *  и загружает план новой (см. docs/specs/2026-09-29-session-plan-binding-design.md). */
  private sessionId: string | null = null;
  private verifier: StepVerifier;
  /**
   * Диагностический sink (INV-15, W0.6): пишет `verify_error`, когда проверка
   * шага не выполнена, но признана валидной (нет tsc/tsconfig/тестов). Ставит
   * Agent после создания `SessionLogger`; без агента (юнит-тесты) — no-op.
   */
  private diagnosticSink?: (event: "verify_error", diag: Diagnostic) => void;
  private stuckDetector: StuckDetector;
  private auditor: Auditor;
  private store: PlanStore;
  private baseDir: string;
  // Пропуск первого аудита после восстановления плана с диска — даём юзеру
  // шанс сменить тему, прежде чем audit-gate зафиксируется.
  private _auditSkipsRemaining = 0;
  /**
   * Последний план, ЗАВЕРШЁННЫЙ и авто-архивированный. `plan update` на
   * финальном шаге чистит трекер — раньше runFinalAudit() возвращал null и
   * молча скипал финальный аудит (тесты + tsc + файлы) готовой задачи.
   * Храним завершённый план, чтобы audit-gate отработал.
   */
  private completedPlan: Plan | null = null;
  /**
   * Авто-advance шагов по файловым деливераблам (config execution.autoAdvance).
   * При false харнесс только подталкивает модель закрыть шаг самому.
   */
  private autoAdvance = true;
  /** План завершён в этом ходу — архивировать на границе хода (onTurnEnd). */
  private pendingAutoArchive = false;
  /**
   * Отложенные <system-summary>. Инжектятся onBeforeTool/onAfterTool, но
   * флашатся в onBeforeThink — никогда не встают между assistant tool_call и
   * его tool-результатами (рвёт спаривание и хоронит варнинги, на которые
   * модель должна реагировать).
   */
  private pendingMessages: Array<{ role: "user"; content: string }> = [];
  // Per-командные счётчики фейлов запрещённых Windows-команд (grep/sed/ls/
  // find/… через тул bash). Hard stop после второго фейла evidence-based
  // (реальные фейлы команд), не классификация задач (правило #10).
  private forbiddenBashFailures = new Map<string, number>();
  private searchRunner: WebSearchRunner;
  private searchesThisSession = 0;
  private retryWebSearchSignatures = new Set<string>();
  private lastErrorSearchAt = 0;
  private readonly errorSearchCooldownMs: number;
  private hallucinationDetector: { getConsistencyCheck(): { getDeletedFiles(): string[] } } | null =
    null;

  /**
   * Мутабельное состояние execution-плагина. Владеем ЗДЕСЬ, передаём ПО ССЫЛКЕ
   * фабрике плагина — плагин пишет deps.state.* напрямую, записи видны модулю
   * без write-back.
   */
  private state: ExecutionPluginState = {
    lastRecoveryIteration: -STUCK_RECOVERY_COOLDOWN,
    consecutivePlanWarnings: 0,
    lastStepId: -1,
    stuckNotified: false,
    lastStuckWarnKey: "",
    lastStuckWarnIter: -STUCK_WARN_REPEAT_EVERY,
    escalationDirectiveSent: false,
    depsGateHints: new Map<number, number>(),
    mutationsWithoutPlan: 0,
    planNudgeSent: false,
    typecheckFailures: new Map<string, string>(),
  };

  /**
   * Read/write доступ к трекеру, общий для фабрик plan-tool и execution-plugin.
   * Abort тула `plan` чистит его (current = null) — сеттер держит this.tracker
   * в синхроне. Геттеры литерала биндят `this` на литерал, поэтому инстанс
   * захвачен замыканием.
   *
   * Сеттер зеркалит per-session слот (план следует за сессией): план-тулы
   * (`abort/switch/delete/purge/...`) пишут через trackerRef напрямую, минуя
   * setPlan — без хука слот протух бы и воскрешал отменённый план возвратом
   * в сессию. IO fail-open: слот не должен ронять тулы.
   */
  private trackerRef: {
    get current(): PlanTracker | null;
    set current(v: PlanTracker | null);
  } = (() => {
    const self = this;
    return {
      get current(): PlanTracker | null {
        return self.tracker;
      },
      set current(v: PlanTracker | null) {
        self.tracker = v;
        self.flushSessionPlan();
      },
    };
  })();

  /** Зеркалит текущий трекер в слот активной сессии (null → clear).
   *  Вызывать после прямых присвоений this.tracker вне setPlan/switchSession. */
  private flushSessionPlan(): void {
    if (!this.sessionId) return;
    try {
      if (this.tracker) this.store.saveSessionActive(this.sessionId, this.tracker.getPlan());
      else this.store.clearSessionActive(this.sessionId);
    } catch {
      // fail-open: per-session слот не должен ронять тулы/гейты
    }
  }

  constructor(
    baseDir: string,
    stuckThreshold = 6,
    webSearchThreshold = 5,
    searchRunner: WebSearchRunner = performWebSearch,
    errorSearchCooldownMs = ERROR_SEARCH_MIN_INTERVAL_MS,
  ) {
    this.baseDir = baseDir;
    this.verifier = new StepVerifier(baseDir, (operation, reason) =>
      this.reportDegrade(operation, reason),
    );
    this.stuckDetector = new StuckDetector(stuckThreshold, 3, webSearchThreshold);
    this.auditor = new Auditor(baseDir);
    this.store = new PlanStore(baseDir);
    this.searchRunner = searchRunner;
    this.errorSearchCooldownMs = errorSearchCooldownMs;
  }

  /** Подключить диагностический sink (INV-15); зовёт Agent после создания SessionLogger. */
  setDiagnosticSink(sink: (event: "verify_error", diag: Diagnostic) => void): void {
    this.diagnosticSink = sink;
  }

  /** Fail-open верификатора: `verify_error` с причиной (INV-12/15), не «тихий ok». */
  private reportDegrade(operation: string, reason: string): void {
    this.diagnosticSink?.("verify_error", {
      source: "module:execution",
      operation,
      kind: "skipped",
      cause: reason,
      recoverable: true,
    });
  }

  /** Ставит план активным (синхрон указателя, персист, сброс завершённого/скипов). */
  setPlan(plan: Plan): void {
    this.tracker = new PlanTracker(plan);
    // Указатель мимо done/skipped шагов восстановленного/перепланированного
    // плана: display ("current: step N") и off-track alignment матчатся с
    // реальностью, а не вечно указывают на шаг 1.
    this.tracker.syncCurrentStep();
    this.store.saveActive(plan);
    if (this.sessionId) {
      try {
        this.store.saveSessionActive(this.sessionId, plan);
      } catch {
        // fail-open: per-session слот не должен ронять создание плана
      }
    }
    this.completedPlan = null; // новый план вытесняет завершённый
    this._auditSkipsRemaining = 0; // план явно создан — взводим audit-gate
  }

  /** Персистит мутацию существующего плана (статус шага, todo, kind-switch):
   *  глобальный active.json плюс слот активной сессии. `setPlan` покрывает
   *  создание/переключение, но прямые `store.saveActive` из план-тулов слот не
   *  зеркалили — после reload сайдбар показывал устаревшие статусы шагов. */
  persistPlan(plan: Plan): void {
    this.store.saveActive(plan);
    if (!this.sessionId) return;
    try {
      this.store.saveSessionActive(this.sessionId, plan);
    } catch {
      // fail-open: слот не должен ронять мутацию плана
    }
  }

  /** Переключает трекер на план другой сессии. Персистит текущий трекер
   *  в слот старой сессии, загружает план новой сессии. Завершённый на диске
   *  план — в архив, как в restorePlan. */
  switchSession(id: string | null): void {
    const prev = this.sessionId;
    if (prev === id) return;
    // Персист уходящей стороны. Стартовый трекер без sessionId (restorePlan
    // до известной сессии) усыновляется новой сессией, а не теряется.
    //
    // Уходящий слот НЕ чистим, когда своего трекера нет: отсутствие плана в
    // ЭТОМ инстансе не значит, что у сессии нет плана — в web план сессии
    // принадлежит её per-session раннеру, а общий модуль UI лишь читает слот.
    // Старый `clear` на пустом трекере стирал чужой живой слот (репорт:
    // «план не появляется в сайдбаре» после переключения/создания сессии).
    // Опустение слота владелец фиксирует сам — `flushSessionPlan` при
    // обнулении трекера (abort/архив), а не сторонним наблюдателем.
    if (this.tracker) {
      try {
        this.store.saveSessionActive(prev ?? id ?? "", this.tracker.getPlan());
      } catch {
        // fail-open: битый id слота / ФС — трекер в памяти остаётся
      }
    }
    this.sessionId = id;
    this.completedPlan = null;
    if (!id) {
      this.tracker = null;
      this._auditSkipsRemaining = 0;
      return;
    }
    let plan: Plan | null = null;
    try {
      plan = this.store.loadSessionActive(id);
    } catch {
      plan = null;
    }
    if (!plan) {
      this.tracker = null;
      this._auditSkipsRemaining = 0;
      return;
    }
    const restored = new PlanTracker(plan);
    if (restored.isComplete()) {
      this.store.archivePlan(plan);
      try {
        this.store.clearSessionActive(id);
      } catch {
        /* best-effort */
      }
      this.tracker = null;
      return;
    }
    this.tracker = restored;
    this.tracker.syncCurrentStep();
    this._auditSkipsRemaining = 1; // как восстановленный план
  }

  /** Забывает сессию: чистит её слот плана. Удаляемая сессия не может быть
   *  текущей (web гардит 409), но REPL /delete — может: тогда сбрасываем
   *  и трекер, чтобы не висел план-призрак. */
  forgetSession(id: string): void {
    try {
      this.store.clearSessionActive(id);
    } catch {
      /* best-effort */
    }
    if (this.sessionId === id) {
      this.sessionId = null;
      this.tracker = null;
      this.completedPlan = null;
      this._auditSkipsRemaining = 0;
    }
  }

  /** Вяжет детектор галлюцинаций: тул plan проверяет удалённость файлов (auto-switch kind gate). */
  setHallucinationDetector(detector: {
    getConsistencyCheck(): { getDeletedFiles(): string[] };
  }): void {
    this.hallucinationDetector = detector;
  }

  /** Запоминает последний завершённый план: финальный аудит проверит его и
   *  после очистки трекера авто-архивом. */
  recordCompleted(plan: Plan): void {
    this.completedPlan = plan;
  }

  /** Забывает завершённый план (abort/delete/purge — аудитить нечего). */
  clearCompleted(): void {
    this.completedPlan = null;
  }

  /** Включает/выключает авто-advance шагов (config execution.autoAdvance). */
  setAutoAdvance(enabled: boolean): void {
    this.autoAdvance = enabled;
  }

  /**
   * Архивирует завершённый план на границе хода (onTurnEnd). Раньше архив
   * происходил посреди хода в advancePlanIfStepComplete — модель продолжала
   * звать plan_step/re-plan и получала «нет активного плана». Теперь план
   * живёт до конца хода, а при архивации модель получает явное уведомление.
   */
  archiveCompletedPlan(): void {
    if (!this.pendingAutoArchive && !(this.tracker && this.tracker.isComplete())) return;
    const tracker = this.tracker;
    if (!tracker) {
      this.pendingAutoArchive = false;
      return;
    }
    const completed = tracker.getPlan();
    this.store.archivePlan(completed);
    this.recordCompleted(completed); // final audit still verifies it
    this.tracker = null;
    this.pendingAutoArchive = false;
    this.flushSessionPlan();
    const settled = completed.steps.filter(
      (s) => s.status === "done" || s.status === "skipped",
    ).length;
    this.pendingMessages.push({
      role: "user",
      content: `<system-summary>${t("plan.completed_archived", {
        id: completed.id,
        done: String(settled),
        total: String(completed.steps.length),
      })}</system-summary>`,
    });
  }

  /** Восстанавливает активный план с диска. False, если нет/уже завершён (тогда в архив). */
  restorePlan(): boolean {
    const plan = this.store.loadActive();
    if (!plan) return false;
    const restored = new PlanTracker(plan);
    // План, уже завершённый на момент сохранения, активным не возвращается —
    // архивируем, чтобы не якорил агента (восстановленные готовые планы давали
    // петлю "continue step 4" на рестарте).
    if (restored.isComplete()) {
      this.store.archivePlan(plan);
      this.tracker = null;
      return false;
    }
    this.tracker = restored;
    // Двигаем к первому недонесённому шагу
    this.tracker.syncCurrentStep();
    this._auditSkipsRemaining = 1; // восстановленный план — один свободный проход
    return true;
  }

  /** Трекер (null без активного плана). */
  getTracker(): PlanTracker | null {
    return this.tracker;
  }

  /** Текущий трекаемый план (единый источник правды для UI).
   *  Null в свежей сессии — план с диска восстанавливается только при resume
   *  сессии с историей, REPL протухших планов не видит. */
  getActivePlan(): Plan | null {
    return this.tracker?.getPlan() ?? null;
  }

  /** Стор планов. */
  getStore(): PlanStore {
    return this.store;
  }

  /** Stuck-детектор. */
  getStuckDetector(): StuckDetector {
    return this.stuckDetector;
  }

  /**
   * Автопоиск в вебе повторяющейся ошибки (≥ порога errorWebSearch одинаковых
   * сигнатур). Поиск fire-and-forget (результат тула не блокирует), результаты
   * очередятся <system-summary> в pendingMessages.
   *
   * Гейты: мастер-свитч webSearch + свитч errorWebSearch → повторная сигнатура
   * → не-исканная (или ретрайная) → сессионный кап → содержательный текст ошибки →
   * кулдаун. Один поиск на сигнатуру; пустые результаты — один ретрай
   * (размаркировка раз), затем сигнатура считается исканной.
   */
  maybeSearchError(ctx: ToolContext, call: ToolCall): void {
    if (ctx.config?.webSearch?.enabled === false) return;
    const cfg = ctx.config?.errorWebSearch;
    if (!cfg?.enabled) return;
    const sig = this.stuckDetector.getRepeatedErrorSignature();
    if (!sig) return;
    if (this.stuckDetector.hasErrorSearched(sig) && !this.retryWebSearchSignatures.has(sig)) return;
    if (this.searchesThisSession >= (cfg.maxSearchesPerSession ?? 3)) return;
    const lastError = this.stuckDetector.getLastErrorOutput();
    if (!isSearchableError(lastError)) {
      ctx.logger?.debug(t("exec.error_search_no_query"));
      return;
    }
    const now = Date.now();
    if (now - this.lastErrorSearchAt < this.errorSearchCooldownMs) return;
    const stepDesc = this.tracker?.getCurrentStep()?.description ?? "";
    const query = buildSearchQuery(
      stepDesc,
      this.stuckDetector.getLastBashCommand(),
      lastError,
      call.name,
      cfg.maxQueryChars ?? 200,
    );
    const count = this.stuckDetector.getErrorSignatureCount(sig);
    this.stuckDetector.markErrorSearched(sig);
    this.searchesThisSession++;
    this.lastErrorSearchAt = now;
    const networkConfig = getSessionSecurityConfig(ctx.config, ctx.sessionContext).network;
    this.searchRunner(query, cfg.maxResults ?? 5, networkConfig, cfg.requestTimeoutMs ?? 10000)
      .then((res) => {
        if (!res.success || res.results.length === 0) {
          if (!this.retryWebSearchSignatures.has(sig)) {
            this.retryWebSearchSignatures.add(sig);
            this.stuckDetector.unmarkErrorSearched(sig);
          }
          ctx.logger?.warn(t("exec.error_search_failed", { query }));
          ctx.sessionLog?.plan("web-search", `empty/failed: ${query}`);
          return;
        }
        const resultsText = res.results
          .map((r, i) => `${i + 1}. ${r.title} \u2014 ${r.url}\n   ${r.snippet}`)
          .join("\n");
        this.pendingMessages.push({
          role: "user",
          content: `<system-summary>${t("exec.error_search_results", {
            sig,
            count: String(count),
            query,
            results: resultsText,
          })}</system-summary>`,
        });
      })
      .catch((e) => ctx.logger?.warn(`error web search: ${e.message}`));
  }

  /**
   * Финальный аудит перед правом агента заявить "готово". Null без активного
   * плана; иначе — готовность плана + существование артефактов.
   */
  /**
   * Evidence-based автозакрытие пендинг шагов с deliverables на диске. Мелкие
   * модели рутинно доделывают работу, но забывают бухгалтерию `plan update`
   * (было в ses_mthn3c2a: 2/5 шагов done при всех артефактах на месте — audit-gate
   * реджектил корректный финальный ответ и жёг retry-бюджет на бухгалтерию, не
   * на работу).
   *
   * Стандарт ТОТ ЖЕ, что аудитор применяет к done-шагам: каждый файлоподобный
   * токен описания резолвится в существующий файл. Шаги без файловых токенов
   * остаются пендинг (верифицировать нечего).
   */
  private autoCloseEvidenceSteps(plan: Plan): number {
    let closed = 0;
    for (const step of plan.steps) {
      if (step.status === "done" || step.status === "skipped") continue;
      const tokens = extractFileLikeTokens(stripUrls(step.description));
      if (tokens.length === 0) continue;
      const resolved = tokens.map((f) => findExistingFile(this.baseDir, f));

      if (step.kind === "delete") {
        // Delete-шаг закрыт, только если каждая именованная цель ОТСУТСТВУЕТ.
        // (Старая existence-проверка маркила done при файлах на месте —
        // deliverable-gate инвертировался.)
        if (resolved.some((r) => r !== null)) continue;
      } else {
        // create: каждая цель существует И непуста. Пустой плейсхолдер — не
        // deliverable, а аудитор смотрит только существование — автозакрытие
        // дало бы ложный "passed".
        if (resolved.some((r) => r === null)) continue;
        const empty = resolved.some((r) => {
          try {
            return readFileSync(r!, "utf-8").trim().length < 10;
          } catch {
            return false; // unreadable — fall back to existence
          }
        });
        if (empty) continue;
        // Vacuous-truth guard (ses_mup6p61q): как в живом гейте выше —
        // пендинг-шаг по доказанно старым файлам не закрываем, только по
        // файлам, тронутым за жизнь плана (или нечитаемым — fail-open).
        if (provablyStale(resolved, Date.parse(plan.createdAt))) continue;
      }

      step.status = "done";
      step.note = `auto-closed by final audit: ${
        step.kind === "delete" ? "all named files removed" : "all named files exist with content"
      } (${tokens.join(", ")})`;
      closed++;
    }
    return closed;
  }

  /** Финальный аудит активного/завершённого плана: файлы, тесты, tsc, пендинги. Null — аудитить нечего. */
  async runFinalAudit(): Promise<{
    passed: boolean;
    done: number;
    total: number;
    pendingSteps: string[];
    missingFiles: string[];
    summary: string;
  } | null> {
    // Нет активного трекера: аудитим последний завершённый план вместо bail.
    // План, закрытый через `plan update`, авто-архивируется и чистит трекер;
    // без этого финальный аудит (тесты + tsc + файлы) молча скипался и модель
    // заявляла успех на битых артефактах.
    if (!this.tracker) {
      if (!this.completedPlan) return null;
      const plan = this.completedPlan;
      const autoClosed = this.autoCloseEvidenceSteps(plan);
      const audit = await this.auditor.audit(plan);
      const pendingSteps = plan.steps.flatMap((s) =>
        s.status !== "done" && s.status !== "skipped" ? [`${s.id}. ${s.description}`] : [],
      );
      const done = plan.steps.filter((s) => s.status === "done").length;
      if (autoClosed > 0) {
        this.store.saveActive(plan);
        this.flushSessionPlan();
      }
      return {
        passed: audit.passed && pendingSteps.length === 0,
        done,
        total: plan.steps.length,
        pendingSteps,
        missingFiles: audit.missingFiles,
        summary: audit.summary,
      };
    }
    if (this._auditSkipsRemaining > 0) {
      this._auditSkipsRemaining--;
      return null;
    }
    const plan = this.tracker.getPlan();
    const autoClosed = this.autoCloseEvidenceSteps(plan);
    if (autoClosed > 0) {
      this.store.saveActive(plan);
      this.flushSessionPlan();
    }
    const audit = await this.auditor.audit(plan);
    const pendingSteps = plan.steps.flatMap((s) =>
      s.status !== "done" && s.status !== "skipped" ? [`${s.id}. ${s.description}`] : [],
    );
    const done = plan.steps.filter((s) => s.status === "done").length;
    const passed = audit.passed && pendingSteps.length === 0;
    return {
      passed,
      done,
      total: plan.steps.length,
      pendingSteps,
      missingFiles: audit.missingFiles,
      summary: audit.summary,
    };
  }

  /** Блок системного промпта с чеклистом плана (null без активного/незавершённого). */
  getSystemPromptBlock(): PromptBlock | null {
    if (!this.tracker || this.tracker.isComplete()) return null;
    return {
      content: this.tracker.toPromptBlock(),
      priority: "critical",
      essential: true,
      estimatedTokens: 200,
    };
  }

  /**
   * Короткая строка "текущий план" для сводки компакции. Null без активного
   * плана. Для 9B-моделей важна явная инструкция "continue it, do NOT create
   * a new plan" — после компакции блок плана виден, но модель всё равно
   * пересоздаёт план (было: ses_msvuao0h).
   *
   * Готовый план в сводке — "план done, можно новый", а НЕ "continue step 4,
   * do NOT create a new plan", якоривший петлю ses_msxjbnm4.
   */
  getPlanSummary(): string | null {
    if (!this.tracker) return null;
    const plan = this.tracker.getPlan();
    const done = plan.steps.filter((s) => s.status === "done").length;
    const total = plan.steps.length;
    if (this.tracker.isComplete()) {
      return t("exec.plan_summary_complete", {
        id: plan.id,
        title: plan.title,
        done: String(done),
        total: String(total),
      });
    }
    const current = this.tracker.getCurrentStepIndex() + 1;
    return t("exec.plan_summary_continue", {
      id: plan.id,
      title: plan.title,
      done: String(done),
      total: String(total),
      current: String(current),
    });
  }

  /** Определения тулов модуля (plan/todo/verify через фабрику plan-tool). */
  getToolDefinitions(): ToolDefinition[] {
    return createPlanToolDefinitions({
      store: this.store,
      verifier: this.verifier,
      trackerRef: this.trackerRef,
      preserveActive: () => this.preserveActive(),
      setPlan: (p) => this.setPlan(p),
      persistPlan: (p) => this.persistPlan(p),
      recordCompleted: (p) => this.recordCompleted(p),
      clearCompleted: () => this.clearCompleted(),
      hasStepDeliverables: (s) => this.hasStepDeliverables(s),
      missingStepDeliverables: (s) => this.missingStepDeliverables(s),
      stillExistingDeliverables: (s) => this.stillExistingDeliverables(s),
      parseKinds: (a, st) => this.parseKinds(a, st),
      parseChecks: (a, st) => this.parseChecks(a, st),
      getTaskText: (c) => this.getTaskText(c),
      noActivePlanMessage: () => this.noActivePlanMessage(),
      typecheckFailures: this.state.typecheckFailures,
      baseDir: this.baseDir,
      wasFileDeleted: this.hallucinationDetector
        ? (path: string) =>
            this.hallucinationDetector!.getConsistencyCheck().getDeletedFiles().includes(path)
        : undefined,
    });
  }

  /** Плагин модуля (хуки цикла из фабрики execution-plugin). */
  getPlugin(): AgentPlugin {
    return createExecutionPlugin({
      stuckDetector: this.stuckDetector,
      trackerRef: this.trackerRef,
      pendingMessages: this.pendingMessages,
      forbiddenBashFailures: this.forbiddenBashFailures,
      state: this.state,
      store: this.store,
      checkPlanAlignment: (call) => this.checkPlanAlignment(call),
      advancePlanIfStepComplete: (sl) => advancePlanIfStepComplete(this.stepAdvanceDeps(), sl),
      archiveCompletedPlan: () => this.archiveCompletedPlan(),
      maybeSearchError: (ctx, call) => this.maybeSearchError(ctx, call),
    });
  }

  private preserveActive(): void {
    if (!this.tracker) return;
    const plan = this.tracker.getPlan();
    if (plan.steps.every((s) => s.status === "done" || s.status === "skipped")) {
      this.store.archivePlan(plan);
    } else {
      this.store.saveDraft(plan);
    }
  }

  /** Хост шаг-гейта (INV-23): текущее состояние модуля для `step-advance.ts`. */
  private stepAdvanceDeps(): StepAdvanceDeps {
    return {
      baseDir: this.baseDir,
      tracker: this.tracker,
      store: this.store,
      depsGateHints: this.state.depsGateHints,
      pendingMessages: this.pendingMessages,
      autoAdvance: this.autoAdvance,
      flushSessionPlan: () => this.flushSessionPlan(),
      setPendingAutoArchive: () => {
        this.pendingAutoArchive = true;
      },
    };
  }

  private checkPlanAlignment(call: any): string | null {
    if (!this.tracker) return null;
    const step = this.tracker.getCurrentStep();
    if (!step) return null;

    if (PLAN_ALIGNMENT_EXEMPT_TOOLS.has(call.name)) return null;

    const stepPaths = extractFileLikeTokens(stripUrls(step.description)).map(planPathToken);
    if (stepPaths.length === 0) return null;

    // Инспектируем только path-like аргументы. JSON-стринг всего blob'а args
    // скармливал кодовые токены `content` write_file/edit_file в off-path чек
    // (напр. `import "./styles.css"` в теле файла) и давал фантомные alignment-
    // варнинги на on-track записях.
    const argStr = this.pathArgStrings(call.arguments).join(" ");
    const callPaths = extractFileLikeTokens(stripUrls(argStr)).map(planPathToken);

    if (callPaths.length === 0) return null;

    // Файлы уже ЗАКРЫТЫХ (done/skipped) шагов — легитимные цели переписи:
    // агент итерируется по ним, чиня LSP/type-ошибки. Блок здесь остановил бы
    // нормальный багфикс.
    const plan = this.tracker.getPlan();
    const finishedPaths = new Set<string>();
    for (const s of plan.steps) {
      if (s.status === "done" || s.status === "skipped") {
        extractFileLikeTokens(stripUrls(s.description))
          .map(planPathToken)
          .forEach((p) => finishedPaths.add(p));
      }
    }

    // Двунаправленный overlap path-токенов, общий для ОБЕИХ проверок ниже. Шаг
    // может звать "main.ts", а тул — "src/main.ts" (или наоборот): односторонний
    // `s.includes(p)` частый nested/частичный кейс пропускал (было: перепись
    // src/main.ts закрытого шага флаговалась off-path текущего и помогла
    // hard-block'нуть третий вызов).
    const matchesAny = (p: string, tokens: string[]) =>
      tokens.some((t) => t === p || t.includes(p) || p.includes(t));
    const finished = [...finishedPaths];

    const offPath = callPaths.some((p) => {
      if (matchesAny(p, finished)) return false;
      return !matchesAny(p, stepPaths);
    });
    if (!offPath) return null;

    return t("exec.plan_warning", {
      step: String(step.id),
      description: step.description,
      tool: call.name,
    });
  }

  /** Строковые значения path-like аргументов вызова. Ограничивает off-path
   *  чек аргументами, реально именующими файлы (path, file, dir, src, dst,
   *  source, target, input, output, destination, glob, workdir, cwd, command,
   *  pattern), полезную нагрузку не сканирует. */
  private pathArgStrings(args: Record<string, unknown> | undefined): string[] {
    if (!args) return [];
    const out: string[] = [];
    for (const [key, value] of Object.entries(args)) {
      if (
        !/path|file|dir|src|dst|source|target|input|output|destination|glob|workdir|cwd|command|pattern|query/i.test(
          key,
        )
      ) {
        continue;
      }
      if (typeof value === "string") out.push(value);
      else if (Array.isArray(value)) {
        for (const v of value) if (typeof v === "string") out.push(v);
      }
    }
    return out;
  }


  /**
   * Файловые токены из описания шага, не резолвящиеся в реальный файл.
   * Тот же общий экстрактор токенов (allow-list реальных расширений, URL
   * вырезаны) и subtree-резолвер аудитора: "bicycles.ts" находит
   * "bicycle-shop/src/data/bicycles.ts", а hostname в описании — никогда
   * missing deliverable. Шаги без файловых токенов (чистые команды, прогоны
   * проверок) неверифицируемы.
   */
  private missingStepDeliverables(step: { description: string }): string[] {
    const tokens = extractFileLikeTokens(stripUrls(step.description));
    if (tokens.length === 0) return [];
    return tokens.filter((p) => !findExistingFile(this.baseDir, p));
  }

  /**
   * Файловые токены из описания шага, всё ещё резолвящиеся в реальный файл.
   * Инверсия missingStepDeliverables — для гейта delete-шагов ("done" значит
   * файлы пропали).
   */
  private stillExistingDeliverables(step: { description: string }): string[] {
    const tokens = extractFileLikeTokens(stripUrls(step.description));
    if (tokens.length === 0) return [];
    return tokens.filter((p) => findExistingFile(this.baseDir, p));
  }

  /** Есть ли в описании шага хоть один реальный файловый токен. Шаги без
   *  токенов (чистые команды, прогоны проверок) не автоверифицируются —
   *  done-gate для них vacuous. */
  private hasStepDeliverables(step: { description: string }): boolean {
    return extractFileLikeTokens(stripUrls(step.description)).length > 0;
  }

  /**
   * Валидирует опциональный пер-шаговый аргумент `kinds` для create плана и
   * update-с-шагами. Возвращает выровненные по длине kinds или i18n-строку
   * ошибки. Нет kinds → null (вызывающий фолбэчится на all-create). Общий для
   * ОБЕИХ веток: перестройка через update не дропает kinds молча.
   */
  private parseKinds(
    args: Record<string, unknown>,
    steps: string[],
  ): { kinds: StepKind[] | null; error: string | null } {
    if (args.kinds === undefined) return { kinds: null, error: null };
    if (!Array.isArray(args.kinds)) {
      return { kinds: null, error: t("plan.kinds_not_array") };
    }
    const kindsRaw = args.kinds.map(String);
    if (kindsRaw.length !== steps.length) {
      return { kinds: null, error: t("plan.kinds_mismatch") };
    }
    const invalid = kindsRaw.filter((k) => k !== "create" && k !== "delete");
    if (invalid.length > 0) {
      return {
        kinds: null,
        error: t("plan.kinds_invalid", {
          kinds: invalid.join(", "),
        }),
      };
    }
    return { kinds: kindsRaw as StepKind[], error: null };
  }

  /**
   * Валидирует пер-шаговый аргумент `checks` для create / re-plan плана.
   * Checks НЕОБЯЗАТЕЛЬНЫ: если массив не передан, харнесс проставляет
   * self-certified `manual:<краткая формулировка шага>`. Если длина не совпала —
   * авто-ремонт (паддинг/обрезка), а не отказ: меньше, чем число шагов,
   * добивается `manual:`, лишние отбрасываются. Отдельно валидируются
   * префиксы: file-exists: / command: / manual: (см. plan-checks.ts).
   */
  private parseChecks(
    args: Record<string, unknown>,
    steps: string[],
  ): { checks: string[] | null; error: string | null } {
    if (args.checks === undefined) {
      // Необязательный контракт: self-certified manual-фолбэк, без hard-гейта.
      return {
        checks: steps.map((s) => `manual:${s.trim().slice(0, 60)}`),
        error: null,
      };
    }
    if (!Array.isArray(args.checks)) {
      return { checks: null, error: t("plan.checks_not_array") };
    }
    const raw = args.checks.map(String);
    if (raw.length !== steps.length) {
      // Авто-ремонт вместо отказа: паддинг self-certified `manual:` для шагов
      // без проверки и обрезка лишних. Отказ на мисматче заставлял слабую
      // модель бросить планирование целиком (ses_muwinhpk_2e69iq: два
      // отклонённых create → плана нет). Переданные контракты всё равно
      // валидируются по префиксу.
      const repaired = steps.map((s, i) => raw[i] ?? `manual:${s.trim().slice(0, 60)}`);
      const bad = repaired.filter((c) => !isValidCheck(c));
      if (bad.length > 0) {
        return {
          checks: null,
          error: t("plan.checks_invalid", {
            kinds: bad.slice(0, 3).join("; "),
          }),
        };
      }
      return { checks: repaired, error: null };
    }
    const bad = raw.filter((c) => !isValidCheck(c));
    if (bad.length > 0) {
      return {
        checks: null,
        error: t("plan.checks_invalid", {
          kinds: bad.slice(0, 3).join("; "),
        }),
      };
    }
    return { checks: raw.map((c) => c.trim()), error: null };
  }

  /**
   * Модельно-видимое actionable-сообщение «нет активного плана». Содержит
   * сведения о последнем завершённом плане и действие для продолжения — вместо
   * голого «No active plan», на котором 9B зацикливалась после авто-архива.
   */
  private noActivePlanMessage(): string {
    const last = this.store.listArchived().at(-1);
    if (!last) return t("plan.no_active");
    const done = last.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
    return t("plan.no_active_with_last", {
      id: last.id,
      title: last.title,
      done: String(done),
      total: String(last.steps.length),
    });
  }

  /**
   * Достаёт исходную формулировку задачи из первого user-сообщения истории.
   * Нужно для валидации покрытия плана против требований.
   */
  private getTaskText(ctx: any): string {
    const manager = ctx?.contextManager;
    if (!manager) return "";
    const history = manager.getActiveHistory();
    // Первое user-сообщение может быть инжектированным <system-summary>
    // (блок компакции) — это НЕ задача. Покрытие сравнивает план с реальной
    // инструкцией модели (было: протухший файловый список сводки компакции дал
    // bogus-варнинг "в плане не хватает файлов").
    const firstUser = history.find((m: { role: string; content: string | ContentPart[] }) => {
      if (m.role !== "user") return false;
      const text = getMessageText(m.content);
      return !text.startsWith("<system-summary>") && !text.includes("[Compressed:");
    });
    if (!firstUser) return "";
    return getMessageText(firstUser.content).trim();
  }
}
