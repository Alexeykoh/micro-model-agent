// Персист планов: active/drafts/archive в .mma/plans + миграция legacy plan.json.
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { Logger } from "../../logger/app-logger";
import type { Plan } from "./planner";
import { errMsg } from "../../utils";
import { projectMmaDir } from "../../config/paths";
import {
  readPlanFile,
  writePlanFile,
  listDir,
  toMeta,
  type PlanStatus,
  type PlanMeta,
} from "./plan-store-io";

const log = new Logger("info", "plan-store");

const LEGACY_FILE = "plan.json";

// Типы реэкспортируются: их исторически импортуют из `./plan-store`.
export type { PlanStatus, PlanMeta } from "./plan-store-io";

/** Хранилище планов: active/drafts/archive + миграция legacy-файла. */
export class PlanStore {
  private baseDir: string;
  private plansDir: string;
  private draftsDir: string;
  private archiveDir: string;
  private legacyPath: string;

  constructor(baseDir: string) {
    const mmaDir = projectMmaDir(baseDir);
    if (!existsSync(mmaDir)) mkdirSync(mmaDir, { recursive: true });

    this.baseDir = baseDir;
    this.plansDir = join(mmaDir, "plans");
    this.draftsDir = join(this.plansDir, "drafts");
    this.archiveDir = join(this.plansDir, "archive");
    this.legacyPath = join(mmaDir, LEGACY_FILE);

    for (const dir of [this.plansDir, this.draftsDir, this.archiveDir]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  private activePath(): string {
    return join(this.plansDir, "active.json");
  }

  /** Корень per-session слотов активного плана. */
  private sessionsDir(): string {
    return join(this.plansDir, "sessions");
  }

  /** Проверяет id сессии как сегмент пути (без сепараторов/..). */
  private sessionActivePath(sessionId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      throw new Error(`invalid session id: ${sessionId}`);
    }
    return join(this.sessionsDir(), sessionId, "active.json");
  }

  // ---- Активный план сессии ----

  /** Сохраняет активный план сессии. */
  saveSessionActive(sessionId: string, plan: Plan): void {
    const p = this.sessionActivePath(sessionId);
    const dir = join(this.sessionsDir(), sessionId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writePlanFile(p, plan);
  }

  /** Загружает активный план сессии. Пустая/новая сессия — null.
   *  Без fallback на глобальный active.json: усыновление legacy-плана делает
   *  явно только bootstrap (через switchSession-персист), иначе каждая новая
   *  сессия наследовала бы чужой план. */
  loadSessionActive(sessionId: string): Plan | null {
    const p = this.sessionActivePath(sessionId);
    if (!existsSync(p)) return null;
    return readPlanFile(p, this.baseDir);
  }

  /** Убирает активный план сессии. Нет слота — no-op. */
  clearSessionActive(sessionId: string): void {
    const p = this.sessionActivePath(sessionId);
    if (existsSync(p)) rmSync(p, { force: true });
  }

  // ---- Активный план ----

  /** Сохраняет активный план. */
  saveActive(plan: Plan): void {
    writePlanFile(this.activePath(), plan);
  }

  /** Загружает активный план (с миграцией legacy .mma/plan.json). Null, если нет. */
  loadActive(): Plan | null {
    const activePath = this.activePath();
    if (existsSync(activePath)) {
      const plan = readPlanFile(activePath, this.baseDir);
      if (plan) return plan;
    }
    // Миграция legacy: читаем .mma/plan.json и переносим в active
    if (existsSync(this.legacyPath)) {
      const legacy = readPlanFile(this.legacyPath, this.baseDir);
      if (legacy) {
        this.saveActive(legacy);
        try {
          rmSync(this.legacyPath, { force: true });
        } catch (err) {
          log.warn("Failed to remove migrated legacy plan.json", {
            path: this.legacyPath,
            error: errMsg(err),
          });
        }
        return legacy;
      }
    }
    return null;
  }

  /** Убирает активный план. */
  clearActive(): void {
    const p = this.activePath();
    if (existsSync(p)) rmSync(p, { force: true });
  }

  // ---- Черновики (сохранённые планы) ----

  /** Сохраняет план в черновики. */
  saveDraft(plan: Plan): void {
    writePlanFile(join(this.draftsDir, `${plan.id}.json`), plan);
  }

  /** Загружает черновик по id. Null, если нет. */
  loadDraft(id: string): Plan | null {
    const p = join(this.draftsDir, `${id}.json`);
    return existsSync(p) ? readPlanFile(p, this.baseDir) : null;
  }

  /** Удаляет черновик по id. */
  removeDraft(id: string): void {
    const p = join(this.draftsDir, `${id}.json`);
    if (existsSync(p)) rmSync(p, { force: true });
  }

  /** Все черновики. */
  listDrafts(): Plan[] {
    return listDir(this.draftsDir, this.baseDir);
  }

  // ---- Архив ----

  /** Архивирует план (убирает из черновиков/активного при совпадении). */
  archivePlan(plan: Plan): void {
    writePlanFile(join(this.archiveDir, `${plan.id}.json`), plan);
    // Убираем из черновиков, если там был
    this.removeDraft(plan.id);
    // Если архивируемый был активным — чистим active
    const active = this.loadActive();
    if (active && active.id === plan.id) {
      this.clearActive();
    }
  }

  /** Все архивные планы. */
  listArchived(): Plan[] {
    return listDir(this.archiveDir, this.baseDir);
  }

  /** Удаляет архивный план по id. */
  removeArchived(id: string): void {
    const p = join(this.archiveDir, `${id}.json`);
    if (existsSync(p)) rmSync(p, { force: true });
  }

  // ---- Кросс-статусные запросы ----

  /** Метаданные всех планов (активный + черновики + архив). */
  listAll(): PlanMeta[] {
    const metas: PlanMeta[] = [];
    const active = this.loadActive();
    if (active) metas.push(toMeta(active, "active"));
    for (const p of this.listDrafts()) metas.push(toMeta(p, "draft"));
    for (const p of this.listArchived()) metas.push(toMeta(p, "archived"));
    return metas;
  }

  /** Находит план по id в любом статусе. Null, если нет. */
  find(id: string): { plan: Plan; status: PlanStatus } | null {
    const active = this.loadActive();
    if (active && active.id === id) return { plan: active, status: "active" };
    const draft = this.loadDraft(id);
    if (draft) return { plan: draft, status: "draft" };
    const archived = this.listArchived().find((p) => p.id === id);
    if (archived) return { plan: archived, status: "archived" };
    return null;
  }

  // ---- Удаление (юзер просил: планы должны реально исчезать) ----

  /** Навсегда удаляет план, где бы ни лежал. Возвращает его статус, или null
   *  если плана с таким id нет. */
  deletePlan(id: string): PlanStatus | null {
    const active = this.loadActive();
    if (active && active.id === id) {
      this.clearActive();
      return "active";
    }
    const draftPath = join(this.draftsDir, `${id}.json`);
    if (existsSync(draftPath)) {
      rmSync(draftPath, { force: true });
      return "draft";
    }
    const archivedPath = join(this.archiveDir, `${id}.json`);
    if (existsSync(archivedPath)) {
      rmSync(archivedPath, { force: true });
      return "archived";
    }
    return null;
  }

  /** Удаляет все планы (активный, черновики, архив). Возвращает число удалённых. */
  purgeAll(): number {
    let n = 0;
    const active = this.loadActive();
    if (active) {
      this.clearActive();
      n++;
    }
    for (const p of this.listDrafts()) {
      this.removeDraft(p.id);
      n++;
    }
    for (const p of this.listArchived()) {
      this.removeArchived(p.id);
      n++;
    }
    return n;
  }
}
