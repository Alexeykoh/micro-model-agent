/**
 * Шаг-гейт исполнения (`execution/module.ts`, INV-23): автопродвижение шага
 * плана по файловым деливераблам, гейты зависимостей/пустых файлов/вакуумной
 * истины и доказанная старость файлов. Вынесено из класса `ExecutionModule`.
 */
import { existsSync, readFileSync, statSync } from "fs";
import { resolve } from "path";
import { t } from "../../i18n/index";
import { extractFileLikeTokens, stripUrls } from "../../core/hallucination/js-identifiers";
import { findExistingFile } from "./auditor";
import { stepTypecheckGate } from "./plugin-plan";
import type { PlanTracker } from "./tracker";
import type { PlanStore } from "./plan-store";

const MTIME_SKEW_TOLERANCE_MS = 2000;

/** Маркеры шаблонных заготовок (create-next-app/vite): не пустые, но не работа. */
const SCAFFOLD_TEMPLATE_MARKERS = [
  "To get started, edit the",
  "Get started by editing",
  "Looking for a starting point",
  "We've dropped you a starter template",
  "Welcome to",
  "Learn React",
  "Getting Started with Create",
  "Vite + React",
  "Next.js logo",
  "Vercel Templates",
];

/** Похоже ли содержимое на нетронутый шаблон скаффолда. */
export function looksLikeScaffoldTemplate(content: string, filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  if (!/(?:^|\/)page\.tsx$/.test(normalized) && !/\/(?:layout|app)\.tsx$/.test(normalized)) return false;
  return SCAFFOLD_TEMPLATE_MARKERS.some((m) => content.includes(m));
}

/**
 * Доказанная старость файлов шага: КАЖДЫЙ резолвленный файл создан/изменён не
 * позже `sinceMs` (рождение плана). Только тогда existence — вакуумная истина
 * и автопродвижение/автозакрытие запрещены. Fail-open в обе стороны: битая
 * дата, нечитаемый mtime, пропавший файл — НЕ старость.
 */
export function provablyStale(resolved: (string | null)[], sinceMs: number): boolean {
  if (Number.isNaN(sinceMs)) return false;
  for (const r of resolved) {
    if (!r) return false;
    try {
      // mtime может отставать от `Date.now()` плана на доли мс: допуск
      // поглощает дрейф, реально старые файлы остаются «старыми».
      if (statSync(r).mtimeMs >= sinceMs - MTIME_SKEW_TOLERANCE_MS) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Мутабельный вид `ExecutionModule`, которым владеет шаг-гейт. */
export interface StepAdvanceDeps {
  baseDir: string;
  tracker: PlanTracker | null;
  store: PlanStore;
  depsGateHints: Map<number, number>;
  pendingMessages: Array<{ role: "user"; content: string }>;
  autoAdvance: boolean;
  /** Файловые compile-фейлы текущего хода (см. INV-H3, stepTypecheckGate). */
  typecheckFailures: ReadonlyMap<string, string>;
  flushSessionPlan(): void;
  setPendingAutoArchive(): void;
}

/**
 * Автопродвижение шага плана по файловым деливераблам с гейтами (зависимости →
 * пустые файлы → вакуумная истина → ручной режим). Нуджит модель сообщениями,
 * если шаг не готов; иначе двигает трекер и помечает авто-архив.
 */
export function advancePlanIfStepComplete(
  d: StepAdvanceDeps,
  sessionLog?: { plan(event: string, detail: string, iteration?: number): void },
): void {
  const step = d.tracker?.getCurrentStep();
  if (!step) return;
  const stepText = step.description.toLowerCase();
  // Общий файловый фильтр (allow-list реальных расширений, сегменты только из
  // расширения отброшены). Шаг "Удалить .js, оставить .tsx/.ts" НЕ даёт
  // фантомный токен "tsx/.ts".
  const stepPaths = extractFileLikeTokens(stripUrls(step.description)) || [];

  // Гейт шагов: зависимости проверяем при упоминании — ДО путей файлов.
  const isDepsStep =
    /(?:npm|bun|yarn|pnpm|pip|pip3|pipenv|poetry|composer|deno|go|gem|cargo)\s+(?:install|add|init|i|get)\b|bun\s+(?:add|install)|npm\s+(?:i|install|add)|(?:install|установ\w*)\s+(?:dependencies|зависимост\w*|пакет\w*|packages?)/i.test(
      stepText,
    );
  if (isDepsStep) {
    const lockFiles = [
      "package-lock.json",
      "bun.lockb",
      "yarn.lock",
      "pnpm-lock.yaml",
      "node_modules",
      "go.sum",
      "Cargo.lock",
      "Pipfile.lock",
      "poetry.lock",
      "requirements.txt",
    ];
    const hasLockFile = lockFiles.some((f) => existsSync(resolve(d.baseDir, f)));
    if (!hasLockFile) {
      const hints = d.depsGateHints.get(step.id) || 0;
      d.depsGateHints.set(step.id, hints + 1);
      const force = hints >= 1;
      const content = force
        ? t("exec.step_gate_deps_force", { step: String(step.id) })
        : t("exec.step_gate_deps", { step: String(step.id), description: step.description });
      d.pendingMessages.push({
        role: "user",
        content: `<system-summary>${content}</system-summary>`,
      });
      return;
    }
  }

  if (stepPaths.length === 0) return;

  // Токены резолвим ТЕМ ЖЕ обходом поддерева, что deliverable-gate и аудитор.
  const resolved = stepPaths.map((p) => findExistingFile(d.baseDir, p));
  const allExist = resolved.every((r) => r !== null);
  const allGone = resolved.every((r) => r === null);
  const satisfied = step.kind === "delete" ? allGone && !allExist : allExist;
  if (!satisfied) return;

  // Vacuous-truth guard: для НЕ-delete шагов existence давно лежащих файлов —
  // не done. Delete-шаги проверяют отсутствие файлов.
  if (step.kind !== "delete") {
    const plan = d.tracker?.getPlan();
    if (plan && provablyStale(resolved, Date.parse(plan.createdAt))) return;
  }

  // Гейт шагов: файлы проверяем на контент (не пустые, не шаблонный
  // заготовки create-next-app / create-vite: непустой, но нереальный файл —
  // тот же vacuous-truth, что пустой).
  if (step.kind !== "delete") {
    const emptyFiles: string[] = [];
    const templateFiles: string[] = [];
    for (const r of resolved) {
      if (!r) continue;
      try {
        const content = readFileSync(r, "utf-8");
        if (content.trim().length < 10) {
          emptyFiles.push(r);
          continue;
        }
        if (looksLikeScaffoldTemplate(content, r)) templateFiles.push(r);
      } catch {
        // Нечитаем — откат на existence.
      }
    }
    if (emptyFiles.length > 0) {
      d.pendingMessages.push({
        role: "user",
        content: `<system-summary>${t("exec.step_gate_empty", { step: String(step.id), files: emptyFiles.join(", ") })}</system-summary>`,
      });
      return;
    }
    if (templateFiles.length > 0) {
      d.pendingMessages.push({
        role: "user",
        content: `<system-summary>${t("exec.step_gate_template", { step: String(step.id), files: templateFiles.join(", ") })}</system-summary>`,
      });
      sessionLog?.plan(
        "auto-advance-blocked",
        `Step ${step.id} template gate: ${templateFiles.join(", ")}`,
      );
      return;
    }
  }

  // Typecheck-гейт: авто-продвижение не обходит done-gate (INV-H3). Тот же
  // контракт, что у `plan update status=done`: пока последний write/edit
  // репортит compile-ошибку на файлах шага, шаг нельзя двигать.
  const tcFail = stepTypecheckGate(d.typecheckFailures, step.description);
  if (tcFail) {
    d.pendingMessages.push({
      role: "user",
      content: `<system-summary>${t("plan.typecheck_failed", { step: String(step.id), error: tcFail })}</system-summary>`,
    });
    sessionLog?.plan(
      "auto-advance-blocked",
      `Step ${step.id} typecheck gate: ${tcFail.slice(0, 200)}`,
    );
    return;
  }

  // При выключенном autoAdvance статус ставит модель: подталкиваем закрыть шаг.
  if (!d.autoAdvance) {
    d.pendingMessages.push({
      role: "user",
      content: `<system-summary>${t("exec.step_gate_manual", { step: String(step.id) })}</system-summary>`,
    });
    return;
  }

  // Все проверки прошли — двигаем.
  d.tracker?.updateStepStatus(step.id, "done");
  const hadNext = d.tracker?.advance() ?? false;
  if (d.tracker) {
    d.store.saveActive(d.tracker.getPlan());
    d.flushSessionPlan();
    sessionLog?.plan(
      "auto-advance",
      `Step ${step.id} auto-completed | ${d.tracker.getProgressString()} | current: step ${d.tracker.getCurrentStepIndex() + 1}`,
    );
  }

  const nextStep = hadNext ? d.tracker?.getCurrentStep() : null;
  const nextMsg = nextStep
    ? t("exec.step_gate_ok", {
        step: String(step.id),
        nextStep: String(nextStep.id),
        nextDesc: nextStep.description,
      })
    : t("exec.step_gate_last", { step: String(step.id) });
  d.pendingMessages.push({ role: "user", content: `<system-summary>${nextMsg}</system-summary>` });

  // Авто-архив НЕ здесь: план живёт до границы хода (onTurnEnd →
  // archiveCompletedPlan). Помечаем — архивируется в конце хода.
  if (d.tracker?.isComplete()) {
    d.setPendingAutoArchive();
    sessionLog?.plan(
      "auto-advance",
      `Plan ${d.tracker.getPlan().id} complete — archive at turn end`,
    );
  }
}
