// Хук onBeforeThink execution-плагина (вынесено из `execution-plugin.ts`,
// правило 6): флаш отложенных сообщений, сброс per-step/per-turn состояния,
// stuck-варнинг, recovery/эскалация и nudge плана. Логика перенесена дословно.
import { t } from "../../i18n/index";
import { buildRecoveryText } from "./execution-recovery";
import {
  FORCE_SKIP_THRESHOLD,
  STUCK_RECOVERY_COOLDOWN,
  STUCK_WARN_REPEAT_EVERY,
  type ExecutionPluginDeps,
  type ExecutionThinkContext,
  resetPlanState,
  resetStepFlags,
} from "./plugin-state";
import { nudgePlanIfNeeded } from "./plugin-plan";

export function runBeforeThink(deps: ExecutionPluginDeps, ctx: ExecutionThinkContext): void {
  // Идентификатор хода (монотонный маркер из ContextManager.beginTurn()).
  const turnSeq = typeof ctx?.turnSeq === "number" ? ctx.turnSeq : 0;
  // Отложенные <system-summary> флашим первыми: видны следующему вызову
  // модели, но не interleav'ят tool-сообщения.
  if (ctx.contextManager && deps.pendingMessages.length > 0) {
    for (const m of deps.pendingMessages.splice(0)) {
      ctx.contextManager.addMessage(m);
    }
  }
  if (deps.trackerRef.current?.isComplete()) {
    // Все шаги done/skipped — перестаём считать "no progress" против
    // последнего шага и глушим step-stuck варнинги готового плана, НО
    // историю вызовов храним, чтобы петли повторов ловились.
    deps.stuckDetector.resetStepProgress();
    resetPlanState(deps.state);
  } else {
    const step = deps.trackerRef.current?.getCurrentStep();
    if (deps.trackerRef.current && step) {
      if (step.id !== deps.state.lastStepId) {
        resetStepFlags(deps.state, step.id);
      }
      deps.stuckDetector.setCurrentStep(step.id, step.description);
      deps.stuckDetector.recordIteration(step.id);
      // A plan is active — any mutation counter no longer applies.
      deps.state.mutationsWithoutPlan = 0;
      deps.state.planNudgeSent = false;
    } else {
      // До-плана: историю цикла (свежие вызовы) храним, чтобы петли
      // повторов ловились и без плана. Но per-step улики фейлов сбрасываются
      // РАЗ В ХОД, а не каждую итерацию: иначе `hasConsecutiveFailures`
      // без плана не срабатывает никогда (§1.2 аудита).
      if (deps.state.lastTurnResetIteration !== turnSeq) {
        deps.stuckDetector.resetStepProgress();
        deps.state.lastTurnResetIteration = turnSeq;
      }
      resetStepFlags(deps.state, -1);

      nudgePlanIfNeeded(deps, ctx);
    }
  }
  const stuckReason = deps.stuckDetector.getStuckReason();
  if (stuckReason) {
    // Логируем раз на эпизод варнинга, а не спамим каждую итерацию: новый
    // ключ — сразу; ТОТ ЖЕ ключ — только каждые STUCK_WARN_REPEAT_EVERY
    // итераций. Step-stuck причина хранит свой once-per-episode флаг.
    const isStuck = deps.stuckDetector.isStuck();
    const warnKey = deps.stuckDetector.getWarningKey();
    const iter = typeof ctx.iteration === "number" ? ctx.iteration : 0;
    const logIt = isStuck
      ? !deps.state.stuckNotified
      : warnKey !== deps.state.lastStuckWarnKey ||
        // Кулдаун варнинга считаем ВНУТРИ хода: прошлый ход не должен
        // «выбрать» новый (§1.11).
        deps.state.lastStuckWarnTurn !== turnSeq ||
        iter - deps.state.lastStuckWarnIter >= STUCK_WARN_REPEAT_EVERY;
    if (logIt) {
      // Внутренняя диагностика петли (счётчики упавших тулов, шаги плана):
      // в чате видна только в режиме «подробно» (STYLE.md, quiet by default).
      if (typeof ctx.logger?.diagnostic === "function") {
        ctx.logger.diagnostic("warn", stuckReason);
      } else {
        ctx.logger?.warn(stuckReason);
      }
      ctx.sessionLog?.directive(
        "stuck-warning",
        stuckReason,
        typeof ctx.iteration === "number" ? ctx.iteration : undefined,
      );
      deps.state.lastStuckWarnKey = warnKey;
      deps.state.lastStuckWarnIter = iter;
      deps.state.lastStuckWarnTurn = turnSeq;
      if (isStuck) deps.state.stuckNotified = true;
    }
  } else {
    deps.state.lastStuckWarnKey = "";
  }
  if (
    deps.stuckDetector.isStuck() ||
    deps.stuckDetector.hasShellUnavailable() ||
    deps.stuckDetector.hasRepetitiveToolCalls() ||
    deps.stuckDetector.hasBashFlailing() ||
    deps.stuckDetector.hasConsecutiveFailures() ||
    deps.stuckDetector.hasReadOnlyStreak()
  ) {
    const currentIter = typeof ctx.iteration === "number" ? ctx.iteration : 0;
    // Кулдаун recovery — внутри хода: прошлый ход на 30 итераций не должен
    // «отнимать» recovery у следующего хода (§1.11 аудита).
    const recoveryReady =
      deps.state.lastRecoveryTurn !== turnSeq ||
      currentIter - deps.state.lastRecoveryIteration >= STUCK_RECOVERY_COOLDOWN;
    if (recoveryReady) {
      const recovery = deps.stuckDetector.getRecoveryMessage();
      if (recovery && ctx.contextManager) {
        // Префикс стабильной машиночитаемой классификации: модель видит,
        // ПОЧЕМУ застряла, до локализованного recovery-гайданса.
        const diagnostic = deps.stuckDetector.getStuckDiagnostic(currentIter);
        const currentStep = deps.trackerRef.current?.getCurrentStep();
        const text = buildRecoveryText({
          recovery,
          ...(diagnostic ? { diagnostic } : {}),
          typecheckFailures: deps.state.typecheckFailures,
          ...(currentStep ? { stepDescription: currentStep.description } : {}),
        });
        ctx.contextManager.addMessage({
          role: "user",
          content: `<system-summary>${text}</system-summary>`,
        });
      }
      deps.stuckDetector.recordEscalation();
      deps.state.lastRecoveryIteration = currentIter;
      deps.state.lastRecoveryTurn = turnSeq;

      if (deps.stuckDetector.shouldEscalate()) {
        const escalation = t("exec.escalation", {
          stepId: String(deps.trackerRef.current?.getCurrentStep()?.id ?? "?"),
          description: deps.trackerRef.current?.getCurrentStep()?.description ?? "",
        });
        // Эскалируем МОДЕЛИ, а не только UI-баннеру: после нескольких попыток
        // восстановления даём явные общие опции (сменить подход, поискать
        // ошибку, спросить юзера, re-plan/skip) вместо повтора того же
        // фейлящегося действия. Инжектится раз на эпизод.
        if (!deps.state.escalationDirectiveSent && ctx.contextManager) {
          deps.state.escalationDirectiveSent = true;
          ctx.contextManager.addMessage({
            role: "user",
            content: `<system-summary>${t("exec.escalation_directive")}</system-summary>`,
          });
        }
        ctx.onMeta?.(escalation);
      }

      // Форс-скип после слишком долгого сидения на одном шаге
      if (
        deps.stuckDetector.getIterationsOnCurrentStep() >= FORCE_SKIP_THRESHOLD &&
        ctx.contextManager
      ) {
        const step = deps.trackerRef.current?.getCurrentStep();
        ctx.contextManager.addMessage({
          role: "user",
          content: `<system-summary>${t("exec.stop_directive", {
            stepId: String(step?.id ?? "?"),
            description: step?.description ?? "",
            iterations: String(deps.stuckDetector.getIterationsOnCurrentStep()),
          })}</system-summary>`,
        });
      }
    }
  }
}
