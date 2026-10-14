// Execution-плагин: хуки цикла (stuck, план, typecheck, автопродвижение, веб-поиск ошибок).
import type { AgentPlugin } from "../types";
import type { ToolCall } from "../../tools/types";
import { t } from "../../i18n/index";
import type { StuckDetector } from "./stuck-detector";
import type { PlanTracker } from "./tracker";
import type { PlanStore } from "./plan-store";
import { detectTestResults } from "../../tools/bash";
import { forbiddenWindowsCommand } from "./windows-commands";
import { extractFileLikeTokens, stripUrls } from "../../core/hallucination/js-identifiers";
import { toForwardSlash } from "../../tools/path-utils";
import { platform } from "os";
import { switchStepToDelete } from "./plan-steps";

/**
 * Кулдаун (в итерациях) между инжектами stuck-восстановления. Экспортируется,
 * чтобы ExecutionModule сидировал state.lastRecoveryIteration тем же офсетом,
 * с которым плагин сравнивает.
 */
export const STUCK_RECOVERY_COOLDOWN = 5;
const MAX_PLAN_WARNINGS_BEFORE_BLOCK = 3;
const FORCE_SKIP_THRESHOLD = 10;
/** Один и тот же stuck-варнинг перелоггируем не чаще каждых N итераций (новый
 *  ключ — всегда сразу). Не даёт идентичному варнингу флудить каждую итерацию
 *  (было в ses_mt4fn58c: "Tool bash failed N times" после ~30 успешных записей). */
export const STUCK_WARN_REPEAT_EVERY = 5;
/** Сколько файл-мутирующих вызовов (write/edit/bash/download) без активного
 *  плана триггерит nudge создания плана. Evidence-based (правило #10):
 *  агент явно работает с файлами — план оправдан. */
const PLAN_NUDGE_THRESHOLD = 2;

/** Тулы, чей успех мог поменять ФС — после них перепроверяем deliverables
 *  текущего шага для автопродвижения. Read-only осознанно исключены (см. вызов
 *  advance в onAfterTool ниже). */
const FS_MUTATING_TOOLS = new Set([
  "write_file", "append_file",
  "edit_file",
  "delete_file",
  "move_file",
  "create_dir",
  "bash",
  "download_file",
  "subagent",
  "mcp_call",
  "pipeline_run",
  "browser",
]);

/**
 * Мутабельное состояние, в которое пишет плагин. Модуль ВЛАДЕЕТ объектом и
 * передаёт по ссылке — каждая запись здесь видна модулю.
 */
export interface ExecutionPluginState {
  lastRecoveryIteration: number;
  consecutivePlanWarnings: number;
  lastStepId: number;
  stuckNotified: boolean;
  /** Стабильный ключ последнего залогированного stuck-варнинга (getWarningKey) + итерация. */
  lastStuckWarnKey: string;
  lastStuckWarnIter: number;
  /** Model-facing директива эскалации уже инжектилась в текущем stuck-эпизоде
   *  (не повторяем каждый кулдаун). */
  escalationDirectiveSent: boolean;
  depsGateHints: Map<number, number>;
  /** Вызовы write/edit/bash/download БЕЗ активного плана. */
  mutationsWithoutPlan: number;
  /** Nudge создания плана уже инжектился. */
  planNudgeSent: boolean;
  /**
   * Файлы, которые последний write/edit пометил как роняющие проектный
   * typecheck или синтаксис-чек, → первая строка ошибки. Чистится чистым
   * результатом write/edit (дебаунснутый проектный tsc перегнал и прошёл).
   * Done-gate плана реджектит "done", пока файлы шага здесь.
   */
  typecheckFailures: Map<string, string>;
}

/** Зависимости плагина: детектор, трекер, стор, гейты (владеет всем модуль). */
export interface ExecutionPluginDeps {
  stuckDetector: StuckDetector;
  trackerRef: { readonly current: PlanTracker | null };
  pendingMessages: Array<{ role: "user"; content: string }>;
  forbiddenBashFailures: Map<string, number>;
  state: ExecutionPluginState;
  store: PlanStore;
  checkPlanAlignment(call: any): string | null;
  advancePlanIfStepComplete(sessionLog?: {
    plan(event: string, detail: string, iteration?: number): void;
  }): void;
  /** Архивирует завершённый план на границе хода (onTurnEnd). */
  archiveCompletedPlan(): void;
  maybeSearchError: (ctx: any, call: any) => void;
}

/** Сломанный компиляцией файл ("" — без привязки к файлу). */
export interface BrokenFile {
  file: string;
  error: string;
}

function normalizeBrokenPath(p: string): string {
  return toForwardSlash(p).replace(/^\.\//, "");
}

/** Парсит строку ошибки tsc / bun build / node --check в путь файла.
 *  Null, если в строке нет привязки к файлу (напр. `error: Could not
 *  resolve "..."`). */
export function parseBrokenFile(line: string): string | null {
  const trimmed = line.trim();
  // tsc: src/index.tsx(17,15): error TS2322: ...
  const tsc = /^(.+?)\s*\(\d+,\d+\)\s*:\s*error TS\d+/.exec(trimmed);
  if (tsc) return normalizeBrokenPath(tsc[1]);
  // bun build / node --check: /abs/file.tsx:1:10: error: ...
  const bn = /^(.+?):\d+:\d+\s*:\s*(?:error|SyntaxError)/.exec(trimmed);
  if (bn) return normalizeBrokenPath(bn[1]);
  return null;
}

/** Вытаскивает пофайловые compile-фейлы из вывода write/edit. Смотрит только
 *  строки-маркеры (`[Project typecheck failed]: <line>` /
 *  `[Syntax check failed]: <line>`), чтобы тело диффа не давало ложных. */
export function extractBrokenFiles(output: string): BrokenFile[] {
  const out: BrokenFile[] = [];
  for (const line of output.split("\n")) {
    const marker = /\[(?:Project typecheck failed|Syntax check failed)\]:\s*(.+)$/.exec(line);
    if (!marker) continue;
    const errLine = marker[1].trim();
    out.push({ file: parseBrokenFile(errLine) ?? "", error: errLine.slice(0, 300) });
  }
  return out;
}

/** Сброс пер-шаговых флагов при смене активного шага (или его отсутствии: -1). */
function resetStepFlags(state: ExecutionPluginState, stepId: number): void {
  state.consecutivePlanWarnings = 0;
  state.lastStepId = stepId;
  state.stuckNotified = false;
  state.escalationDirectiveSent = false;
}

/** Полный сброс состояния плана (завершён или его нет). */
function resetPlanState(state: ExecutionPluginState): void {
  state.consecutivePlanWarnings = 0;
  state.lastStepId = -1;
  state.stuckNotified = false;
  state.mutationsWithoutPlan = 0;
  state.planNudgeSent = false;
  state.escalationDirectiveSent = false;
}

/**
 * Гейт для `plan update status=done`: реджектит, пока последний write/edit
 * репортит compile-ошибку. Фейл без привязки к файлу блокирует весь проект;
 * иначе именованные токены файлов шага матчатся против битых (суффикс пути,
 * регистронезависимо). Шаг без файлов обвинить не в чем — его done остаётся
 * vacuous. Возвращает первую ошибку для показа модели, или null чтобы пустить.
 */
export function stepTypecheckGate(
  failures: ReadonlyMap<string, string>,
  stepDescription: string,
): string | null {
  if (failures.size === 0) return null;
  const projectError = failures.get("");
  if (projectError) return projectError;
  const stepTokens = extractFileLikeTokens(stripUrls(stepDescription)).map((p) =>
    normalizeBrokenPath(p).toLowerCase(),
  );
  if (stepTokens.length === 0) return null;
  for (const [file, err] of failures) {
    const f = normalizeBrokenPath(file).toLowerCase();
    if (stepTokens.some((tok) => f.endsWith(tok) || tok.endsWith(f))) return err;
  }
  return null;
}

/**
 * Хуки execution-плагина, вынесенные дословно из ExecutionModule.getPlugin().
 * Всё разделяемое мутабельное состояние (pendingMessages, forbiddenBashFailures,
 * state, tracker) принадлежит модулю и мутируется по ссылке через `deps`.
 */
export function createExecutionPlugin(deps: ExecutionPluginDeps): AgentPlugin {
  return {
    name: "execution",
    onBeforeThink: (ctx: any) => {
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
          // повторов ловились и без плана. `reset()` тёр её каждую итерацию,
          // отключая детекцию.
          deps.stuckDetector.resetStepProgress();
          resetStepFlags(deps.state, -1);

          // Evidence-based nudge плана (правило #10 — без голого счётчика
          // итераций, без keyword-классификации задач): только когда агент
          // реально сделал файл-мутирующие вызовы (write/edit/bash/download)
          // без плана, ему нужен план.
          const mutations = deps.state.mutationsWithoutPlan;
          if (
            mutations >= PLAN_NUDGE_THRESHOLD &&
            !deps.state.planNudgeSent &&
            ctx.contextManager
          ) {
            deps.state.planNudgeSent = true;
            ctx.contextManager.addMessage({
              role: "user",
              content: `<system-summary>${t("exec.plan_nudge", {
                count: String(mutations),
              })}</system-summary>`,
            });
          }
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
            iter - deps.state.lastStuckWarnIter >= STUCK_WARN_REPEAT_EVERY;
        if (logIt) {
          ctx.logger?.warn(stuckReason);
          ctx.sessionLog?.plan(
            "stuck-warning",
            stuckReason,
            typeof ctx.iteration === "number" ? ctx.iteration : undefined,
          );
          deps.state.lastStuckWarnKey = warnKey;
          deps.state.lastStuckWarnIter = iter;
          if (isStuck) deps.state.stuckNotified = true;
        }
      } else {
        deps.state.lastStuckWarnKey = "";
      }
      if (
        deps.stuckDetector.isStuck() ||
        deps.stuckDetector.hasRepetitiveToolCalls() ||
        deps.stuckDetector.hasBashFlailing() ||
        deps.stuckDetector.hasConsecutiveFailures()
      ) {
        const currentIter = typeof ctx.iteration === "number" ? ctx.iteration : 0;
        if (currentIter - deps.state.lastRecoveryIteration >= STUCK_RECOVERY_COOLDOWN) {
          const recovery = deps.stuckDetector.getRecoveryMessage();
          if (recovery && ctx.contextManager) {
            // Прикладываем контекст tsc-ошибки, чтобы модель знала, ПОЧЕМУ застряла.
            let tscContext = "";
            if (deps.state.typecheckFailures.size > 0) {
              const currentStep = deps.trackerRef.current?.getCurrentStep();
              if (currentStep) {
                const stepFiles = extractFileLikeTokens(stripUrls(currentStep.description));
                for (const [file, error] of deps.state.typecheckFailures) {
                  if (!file || stepFiles.some((f) => file.endsWith(f) || f.endsWith(file))) {
                    tscContext = `\nLast compile error: ${error}`;
                    break;
                  }
                }
                if (!tscContext) {
                  const first = deps.state.typecheckFailures.entries().next().value;
                  if (first) tscContext = `\nLast compile error: ${first[1]}`;
                }
              }
            }

            // Префикс стабильной машиночитаемой классификации: модель видит,
            // ПОЧЕМУ застряла, до локализованного recovery-гайданса.
            const diagnostic = deps.stuckDetector.getStuckDiagnostic(currentIter);
            ctx.contextManager.addMessage({
              role: "user",
              content: `<system-summary>${diagnostic ? `${diagnostic}\n` : ""}${recovery}${tscContext}</system-summary>`,
            });
          }
          deps.stuckDetector.recordEscalation();
          deps.state.lastRecoveryIteration = currentIter;

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
    },
    onBeforeTool: (_ctx: any, call: ToolCall) => {
      const warning = deps.checkPlanAlignment(call);
      if (warning) {
        deps.pendingMessages.push({
          role: "user",
          content: `<system-summary>${warning}</system-summary>`,
        });
        deps.state.consecutivePlanWarnings++;
        if (deps.state.consecutivePlanWarnings >= MAX_PLAN_WARNINGS_BEFORE_BLOCK) {
          deps.pendingMessages.push({
            role: "user",
            content: `<system-summary>${t("exec.plan_blocked", { step: String(deps.trackerRef.current?.getCurrentStep()?.id ?? "?"), max: MAX_PLAN_WARNINGS_BEFORE_BLOCK })}</system-summary>`,
          });
          // Блок с явной причиной, чтобы модель видела, ПОЧЕМУ вызов
          // заблокирован (executor показывает через tool.blocked_reason).
          return t("exec.plan_blocked", {
            step: String(deps.trackerRef.current?.getCurrentStep()?.id ?? "?"),
            max: MAX_PLAN_WARNINGS_BEFORE_BLOCK,
          });
        }
      } else {
        deps.state.consecutivePlanWarnings = 0;
      }
      return true;
    },
    onToolCall: (ctx: any) => {
      const toolName = ctx?.toolName as string;
      const args = ctx?.args as Record<string, unknown>;
      if (toolName && args) {
        deps.stuckDetector.recordToolCall(toolName, args);
        // Считаем файл-мутирующие вызовы БЕЗ активного плана — питают
        // evidence-based nudge создания плана в onBeforeThink.
        if (
          !deps.trackerRef.current &&
          (toolName === "write_file" ||
            toolName === "edit_file" ||
            toolName === "bash" ||
            toolName === "download_file")
        ) {
          deps.state.mutationsWithoutPlan++;
        }
      }
    },
    onAfterTool: (ctx: any, call: any, result: any) => {
      // Запоминаем каждый вызов bash (успех или нет): детекция рассуждает,
      // напр., о повторных прогонах с пустым выводом.
      if (call.name === "bash") {
        deps.stuckDetector.recordBashOutput(
          String(call.arguments?.command ?? ""),
          String(result.output ?? ""),
        );
      }
      // Авто-детект delete-намерения из действий модели: при вызове delete_file
      // находим совпадающий шаг плана и ставим kind="delete". Языконезависимо —
      // по СДЕЛАННОМУ моделью, не по сказанному.
      if (call.name === "delete_file" && result.success && deps.trackerRef.current) {
        const deletedPath = String(call.arguments?.path ?? "");
        if (deletedPath) {
          const plan = deps.trackerRef.current.getPlan();
          const tokens = extractFileLikeTokens(stripUrls(deletedPath));
          for (const step of plan.steps) {
            if (step.status !== "pending" && step.status !== "in_progress") continue;
            const stepTokens = extractFileLikeTokens(stripUrls(step.description));
            const overlap = tokens.some((t) =>
              stepTokens.some((st) => t.endsWith(st) || st.endsWith(t)),
            );
            if (overlap) {
              switchStepToDelete(plan, step, (p) => deps.store.saveActive(p));
              break;
            }
          }
        }
      }
      // write/edit/bash с успехом, но type/syntax-ошибкой в выводе — НЕ успех:
      // модель чинит реальную ошибку, а не переписывает файл вслепую. Кормим
      // stuck-детектор, чтобы сработал хинт rewrite-петли.
      const toolText = String(result.output ?? "");
      const hasTypeError = /error TS\d+|\[Project typecheck failed\]|\[Syntax check failed\]/.test(
        toolText,
      );
      if (hasTypeError) {
        deps.stuckDetector.recordToolError(call.name, toolText.slice(0, 300));
      }
      // Трекаем compile-фейлы пофайлово: done-gate плана реджектит "done", пока
      // последняя правка не компилируется (было: агент маркил шаги done, а
      // проектный typecheck фейлился на каждой записи — каскад "починю позже").
      // ЧИСТЫЙ результат чистит карту: дебаунснутый проектный tsc перегнал и
      // прошёл (или tsconfig неприменим) — старые фейлы завершение вечно не
      // блокируют.
      if (call.name === "write_file" || call.name === "edit_file") {
        const broken = extractBrokenFiles(toolText);
        if (broken.length > 0) {
          for (const b of broken) deps.state.typecheckFailures.set(b.file, b.error);
        } else if (result.success) {
          // Чистим только записи только что писанного/правленного файла (и
          // проектную безадресную запись, которую чистая правка вероятно
          // закрыла). Сплошной `.clear()` стирал несвязанный успешной правкой
          // чужой фейл, обходя done-gate.
          const edited = normalizeBrokenPath(String(call.arguments?.path ?? ""));
          for (const key of [...deps.state.typecheckFailures.keys()]) {
            if (
              key === "" ||
              !edited ||
              key === edited ||
              key.endsWith(edited) ||
              edited.endsWith(key)
            ) {
              deps.state.typecheckFailures.delete(key);
            }
          }
        }
      }
      if (!result.success) {
        // Исход bash-попытки кормим во флейлинг-окно ДО пер-командной обработки —
        // ротация разных фейлящихся команд (wc → cat → Get-Content → …) обязана
        // триггерить детектор.
        if (call.name === "bash") {
          deps.stuckDetector.recordBashAttempt(false);
        }
        // Hard stop для запрещённых Windows-команд: после второго фейла той же
        // запрещённой команды (grep/sed/ls/find/…) инжектим STOP, чтобы сессия
        // не жгла bash-вызовы на командах без cmd.exe. Зеркалит собственный
        // win32-gated hard-stop тула bash (src/tools/bash.ts) — на macOS/Linux
        // эти команды есть и фейлятся по легитимным причинам.
        if (call.name === "bash" && platform() === "win32") {
          const cmd = String(call.arguments?.command ?? "");
          const forbidden = forbiddenWindowsCommand(cmd);
          if (forbidden) {
            const n = (deps.forbiddenBashFailures.get(forbidden) || 0) + 1;
            deps.forbiddenBashFailures.set(forbidden, n);
            if (n === 2) {
              deps.pendingMessages.push({
                role: "user",
                content: `<system-summary>${t("exec.forbidden_cmd", { cmd: forbidden })}</system-summary>`,
              });
            }
          }
        }
        // Type/syntax-ошибка в иначе "успешном" результате уже записана выше.
        // Фейлящийся вызов (result.success === false) иначе посчитал бы ту же
        // ошибку дважды (typecheck-ветка + failure-ветка), раздув счётчик
        // error-сигнатур и триггернув веб-поиск на половине порога.
        if (!hasTypeError) {
          deps.stuckDetector.recordToolError(call.name, result.output);
        }
      } else {
        // "Успешная" запись/правка может нести type/syntax-ошибку (lint-on-write
        // хук аппендит её, оставляя success:true). Скормленный здесь
        // recordToolSuccess() отменял recordToolError выше на том же вызове —
        // rewrite-loop сигнал не накапливался.
        if (!hasTypeError) deps.stuckDetector.recordToolSuccess();
        if (call.name === "bash") {
          deps.stuckDetector.recordBashAttempt(true);
        }

        // Успешно отработавшая команда bash с кодом — предлагаем маркить шаг
        // done, если только вывод не показывает упавшие тесты (их нельзя
        // репортить чистым успехом).
        if (call.name === "bash" && result.success) {
          const cmd = String(call.arguments?.command ?? "");
          const testRun = detectTestResults(String(result.output ?? ""));
          if (testRun && testRun.failed > 0) {
            deps.pendingMessages.push({
              role: "user",
              content: `<system-summary>${t("exec.test_fail_summary", {
                framework: testRun.framework,
                failed: String(testRun.failed),
                passed: String(testRun.passed),
              })}</system-summary>`,
            });
          } else if (testRun && testRun.failed === 0 && testRun.passed > 0) {
            deps.pendingMessages.push({
              role: "user",
              content: `<system-summary>${t("exec.test_pass_summary", {
                framework: testRun.framework,
                passed: String(testRun.passed),
                cmd,
              })}</system-summary>`,
            });
          }
        }
      }

      if (result.success && (call.name === "write_file" || call.name === "edit_file")) {
        const filePath = call.arguments?.path as string;
        if (filePath) {
          deps.stuckDetector.recordFileRewrite(filePath);
          if (deps.stuckDetector.hasExcessiveRewrites()) {
            const file = deps.stuckDetector.getExcessiveRewriteFile();
            const count = deps.stuckDetector.getFileRewriteCount(file!);
            if (ctx.onMeta) {
              ctx.onMeta(
                t("exec.file_rewrite_warning", {
                  file: file!,
                  count: String(count),
                }),
              );
            }
          }
        }
      }

      // Автопродвижение срабатывает после каждого успешного ФС-МУТИРУЮЩЕГО
      // тула, не только write_file/edit_file. Мелкие модели часто создают файлы
      // через bash (`echo ... > f`, heredoc'и) или delete/move через shell
      // вместо выделенных тулов — план тогда не двигается с шага, хотя
      // deliverables на диске (сертификация 3.5/3.8: файлы на месте, план
      // висит на 1/4 и 4/5). Read-only тулы исключены: успешный read/glob иначе
      // закрыл бы шаг "Update X", чей файл существует с раннего шага, — без
      // единой правки. advancePlanIfStepComplete — no-op, если токены не резолвятся.
      if (result.success && FS_MUTATING_TOOLS.has(call.name)) {
        deps.advancePlanIfStepComplete(ctx.sessionLog);
      }

      // Автопоиск в вебе повторяющейся ошибки (fire-and-forget, результаты
      // падают в pendingMessages на следующем флаше onBeforeThink).
      deps.maybeSearchError(ctx, call);
    },
    // Граница хода: завершённый авто-advance'ом план архивируется здесь, а не
    // посреди работы (модель не видит «нет активного плана» в своём же ходу).
    onTurnEnd: () => deps.archiveCompletedPlan(),
  };
}
