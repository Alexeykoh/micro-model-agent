// План и его привязка к сессии: активный трекер, слот сессии, завершённый план
// для финального аудита, пропуски audit-gate. Вынесено из `module.ts` (правило 6).
import { t } from "../../i18n/index";
import type { PromptBlock } from "../../core/types";
import type { Plan } from "./planner";
import { PlanTracker } from "./tracker";
import { PlanStore } from "./plan-store";
import { planPromptBlock, planSummary } from "./plan-prompt";

/** Сообщение, отложенное до начала следующего хода. */
export type PendingMessage = { role: "user"; content: string };

/**
 * Владелец плана модуля. Держит трекер активного плана, его per-session слот,
 * завершённый план (финальный аудит) и счётчик пропусков audit-gate. Публичный
 * API `ExecutionModule` делегирует сюда; порядок операций с диском не менялся.
 */
export class PlanSession {
  private tracker: PlanTracker | null = null;
  /**
   * Сессия-владелец текущего трекера. План следует за сессией: смена сессии
   * через switchSession() персистит трекер в слот старой сессии и загружает
   * план новой (docs/specs/2026-09-29-session-plan-binding-design.md).
   */
  private sessionId: string | null = null;
  /**
   * Последний план, ЗАВЕРШЁННЫЙ и авто-архивированный. `plan update` на
   * финальном шаге чистит трекер — без этого final audit молча скипался бы.
   */
  private completedPlan: Plan | null = null;
  // Пропуск первого аудита после восстановления плана с диска — даём юзеру
  // шанс сменить тему, прежде чем audit-gate зафиксируется.
  private auditSkipsRemaining = 0;
  /** План завершён в этом ходу — архивировать на границе хода (onTurnEnd). */
  private pendingAutoArchive = false;
  readonly store: PlanStore;

  /**
   * Read/write доступ к трекеру, общий для фабрик plan-tool и execution-plugin.
   * Abort тула `plan` чистит его (current = null) — сеттер держит трекер в
   * синхроне и зеркалит per-session слот: план-тулы пишут через trackerRef
   * напрямую, минуя setPlan — без хука слот протух бы и воскрешал отменённый
   * план возвратом в сессию. IO fail-open.
   */
  readonly trackerRef: { current: PlanTracker | null };

  constructor(baseDir: string) {
    this.store = new PlanStore(baseDir);
    const self = this;
    this.trackerRef = {
      get current(): PlanTracker | null {
        return self.tracker;
      },
      set current(v: PlanTracker | null) {
        self.tracker = v;
        self.flushSessionPlan();
      },
    };
  }

  /** Зеркалит текущий трекер в слот активной сессии (null → clear). */
  flushSessionPlan(): void {
    if (!this.sessionId) return;
    try {
      if (this.tracker) this.store.saveSessionActive(this.sessionId, this.tracker.getPlan());
      else this.store.clearSessionActive(this.sessionId);
    } catch {
      // fail-open: per-session слот не должен ронять тулы/гейты
    }
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
    this.auditSkipsRemaining = 0; // план явно создан — взводим audit-gate
  }

  /** Персистит мутацию существующего плана (статус шага, todo, kind-switch):
   *  глобальный active.json плюс слот активной сессии. */
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
      this.auditSkipsRemaining = 0;
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
      this.auditSkipsRemaining = 0;
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
    this.auditSkipsRemaining = 1; // как восстановленный план
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
      this.auditSkipsRemaining = 0;
    }
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

  /**
   * Архивирует завершённый план на границе хода (onTurnEnd). Раньше архив
   * происходил посреди хода в advancePlanIfStepComplete — модель продолжала
   * звать plan_step/re-plan и получала «нет активного плана». Теперь план
   * живёт до конца хода, а при архивации модель получает явное уведомление.
   */
  archiveCompletedPlan(pendingMessages: PendingMessage[]): void {
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
    pendingMessages.push({
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
    // архивируем, чтобы не якорил агента.
    if (restored.isComplete()) {
      this.store.archivePlan(plan);
      this.tracker = null;
      return false;
    }
    this.tracker = restored;
    // Двигаем к первому недонесённому шагу
    this.tracker.syncCurrentStep();
    this.auditSkipsRemaining = 1; // восстановленный план — один свободный проход
    return true;
  }

  /** Трекер (null без активного плана). */
  getTracker(): PlanTracker | null {
    return this.tracker;
  }

  /** Текущий трекаемый план (единый источник правды для UI). */
  getActivePlan(): Plan | null {
    return this.tracker?.getPlan() ?? null;
  }

  /** План, сохранённый при завершении, — вход финального аудита. */
  getCompletedPlan(): Plan | null {
    return this.completedPlan;
  }

  /** Счётчик пропусков audit-gate (final-audit читает и пишет). */
  getAuditSkipsRemaining(): number {
    return this.auditSkipsRemaining;
  }

  setAuditSkipsRemaining(n: number): void {
    this.auditSkipsRemaining = n;
  }

  /** Флаг «план завершён в этом ходу» (ставит step-advance). */
  setPendingAutoArchive(): void {
    this.pendingAutoArchive = true;
  }

  /** Сохраняет активный план как черновик или в архив (create/re-plan). */
  preserveActive(): void {
    if (!this.tracker) return;
    const plan = this.tracker.getPlan();
    if (plan.steps.every((s) => s.status === "done" || s.status === "skipped")) {
      this.store.archivePlan(plan);
    } else {
      this.store.saveDraft(plan);
    }
  }

  /** Блок системного промпта с чеклистом плана (реализация — `plan-prompt.ts`). */
  getSystemPromptBlock(): PromptBlock | null {
    return planPromptBlock(this.tracker);
  }

  /** Строка "текущий план" для сводки компакции (реализация — `plan-prompt.ts`). */
  getPlanSummary(): string | null {
    return planSummary(this.tracker);
  }
}
