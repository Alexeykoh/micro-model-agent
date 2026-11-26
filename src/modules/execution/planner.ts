// План и шаги: типы, создание, re-plan, прогресс, промпт-блок.
import { inferDefaultEvidence } from "./plan-checks";
/** Статус шага плана. */
export type StepStatus = "pending" | "in_progress" | "done" | "failed" | "skipped";

/** Подзадача шага плана (todo внутри шага). */
export interface Subtask {
  id: number;
  text: string;
  done: boolean;
}

/** Вид шага: создание файлов или их удаление (инвертирует deliverable-gate). */
export type StepKind = "create" | "delete";

/** Класс доказательства шага: объявляется моделью, не выводится из описания. */
export type StepEvidence = "static" | "behavioral";

/** Шаг плана: описание, статус, kind, контракт проверки, заметка, подзадачи. */
export interface PlanStep {
  id: number;
  description: string;
  status: StepStatus;
  /** Декларированное моделью намерение. "delete" инвертирует deliverable-gate:
   *  именованные файлы обязаны ОТСУТСТВОВАТЬ, а не присутствовать. По умолчанию "create". */
  kind?: StepKind;
  /** Машиночитаемый контракт верификации шага, объявляется при
   *  create/re-plan: "file-exists:<path>" (жёстко проверяется на done),
   *  "file-modified:<path>" (жёстко: контент отличается от checkBaseline),
   *  "command:<cmd>", "http:<url>[~маркер]", "browser:<url>[~маркер]" или
   *  "web-build:<dir>" (исполняются на done), "manual:<что проверить глазами>"
   *  (self-certified).
   *  Отсутствует только у планов, созданных до checks (back-compat). */
  check?: string;
  /** Декларированный класс доказательства. "behavioral" запрещает закрывать
   *  шаг статикой (file-*:, build) и требует поведенческую проверку. Отсутствие поля
   *  = "static" (back-compat с планами до 2026-11-19). */
  evidence?: StepEvidence;
  /** Снапшот контента для "file-modified:": sha256 на create/re-plan.
   *  null — файла не было; undefined — легаси-план без снапшота (done блокируется). */
  checkBaseline?: string | null;
  note?: string;
  subtasks?: Subtask[];
}

/** План: id, заголовок, шаги, даты, корень, опциональное имя. */
export interface Plan {
  id: string;
  title: string;
  steps: PlanStep[];
  createdAt: string;
  baseDir: string;
  name?: string;
}

function generatePlanId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `plan_${id}`;
}

/**
 * Единый источник правды подсчёта прогресса (ses_mt4fn58c: `show` говорил
 * "6/7 done, complete", а `list` — "7/7" для того же плана: один считал только
 * "done", другой done+skipped). Пропущенный шаг работы не требует, поэтому
 * везде считается settled.
 */
export function getPlanProgress(plan: Plan): {
  done: number;
  skipped: number;
  total: number;
  settled: number;
  terminal: boolean;
} {
  const done = plan.steps.filter((s) => s.status === "done").length;
  const skipped = plan.steps.filter((s) => s.status === "skipped").length;
  const total = plan.steps.length;
  const settled = done + skipped;
  return { done, skipped, total, settled, terminal: total > 0 && settled === total };
}

/** Создатель планов: create, re-plan, промпт-блок. */
export class PlanCreator {
  /** Создаёт новый план из заголовка и описаний шагов. */
  static createPlan(
    title: string,
    stepDescriptions: string[],
    baseDir: string,
    kinds?: StepKind[],
    checks?: (string | undefined)[],
    baselines?: (string | null | undefined)[],
    evidence?: (StepEvidence | undefined)[],
  ): Plan {
    const stepCount = stepDescriptions.length;
    // AQC-1: пропущенное evidence выводится из check, а не из слов описания.
    const resolvedEvidence = evidence ?? inferDefaultEvidence(stepDescriptions, checks);
    return {
      id: generatePlanId(),
      title: `[${stepCount}] ${title}`,
      steps: stepDescriptions.map((desc, i) => ({
        id: i + 1,
        description: desc,
        status: "pending" as StepStatus,
        kind: kinds?.[i] ?? "create",
        ...(checks?.[i] ? { check: checks[i] } : {}),
        ...(baselines?.[i] !== undefined ? { checkBaseline: baselines[i] ?? null } : {}),
        ...(resolvedEvidence[i] ? { evidence: resolvedEvidence[i] } : {}),
      })),
      createdAt: new Date().toISOString(),
      baseDir,
    };
  }

  /** Re-plan: сохраняет done/skipped шаги, заменяет остальные новыми. */
  static replan(
    plan: Plan,
    newSteps: string[],
    title?: string,
    newChecks?: (string | undefined)[],
    newBaselines?: (string | null | undefined)[],
    newEvidence?: (StepEvidence | undefined)[],
  ): Plan {
    const kept = plan.steps.filter((s) => s.status === "done" || s.status === "skipped");
    const baseTitle = plan.title.replace(/^\[\d+[^]]*\]\s*/, "");
    const newTitle = title || baseTitle;
    const totalSteps = kept.length + newSteps.length;
    // AQC-1: шаг, который уже был объявлен behavioral, нельзя переобъявить
    // static при re-plan — иначе проверка поведения исчезает по пути.
    const behavioralBefore = new Set(
      plan.steps
        .filter((s) => s.evidence === "behavioral")
        .map((s) => s.description.trim().toLowerCase()),
    );
    const resolvedEvidence = newEvidence ?? inferDefaultEvidence(newSteps, newChecks);
    const added: PlanStep[] = newSteps.map((desc, i) => {
      const declared = resolvedEvidence[i];
      const evidence =
        declared === "static" && behavioralBefore.has(desc.trim().toLowerCase())
          ? "behavioral"
          : declared;
      return {
        id: -1, // перенумеруется ниже
        description: desc,
        status: "pending" as StepStatus,
        kind: "create",
        ...(newChecks?.[i] ? { check: newChecks[i] } : {}),
        ...(newBaselines?.[i] !== undefined ? { checkBaseline: newBaselines[i] ?? null } : {}),
        ...(evidence ? { evidence } : {}),
      };
    });
    // Перенумеровываем все шаги (сохранённые + новые) подряд. Сохранённые держат
    // статус и kind, но их id могут коллизить с новыми, если исходный план
    // пропускал/пендил шаги в середине (напр. done 1, done 3 → сохранённые
    // [1,3], новые [2…] коллизят с сохранённым id 3).
    const steps = [...kept, ...added].map((s, i) => ({ ...s, id: i + 1 }));
    return {
      id: plan.id,
      title: `[${totalSteps}] ${newTitle}`,
      steps,
      createdAt: plan.createdAt,
      baseDir: plan.baseDir,
      name: plan.name,
    };
  }

  /** Рендерит план чеклистом для промпта (иконки статусов, checks, подзадачи). */
  static toPromptBlock(plan: Plan, currentStepIndex: number): string {
    const date = plan.createdAt.slice(0, 10);
    const p = getPlanProgress(plan);
    const skippedPart = p.skipped > 0 ? `, ${p.skipped} skipped` : "";
    const progress = p.terminal
      ? `${p.settled}/${p.total} done${skippedPart}, complete`
      : `${p.settled}/${p.total} done${skippedPart}, current: step ${currentStepIndex + 1}`;
    const lines: string[] = [
      `[${plan.id}] ${plan.title}`,
      `Dir: ${plan.baseDir}`,
      `Created: ${date} | Progress: ${progress}`,
      ``,
    ];
    for (const step of plan.steps) {
      const icon =
        step.status === "done"
          ? "[x]"
          : step.status === "in_progress"
            ? "[*]"
            : step.status === "failed"
              ? "[!]"
              : step.status === "skipped"
                ? "[-]"
                : "[ ]";
      const note = step.note ? ` — ${step.note}` : "";
      lines.push(`${icon} ${step.id}. ${step.description}${note}`);
      if (step.check) {
        const evidence = step.evidence === "behavioral" ? " (behavioral evidence required)" : "";
        lines.push(`    ↳ check: ${step.check}${evidence}`);
      }
      for (const sub of step.subtasks ?? []) {
        lines.push(`    [${sub.id}] ${sub.done ? "[x]" : "[ ]"} ${sub.text}`);
      }
    }
    return lines.join("\n");
  }
}
