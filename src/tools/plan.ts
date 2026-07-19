import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getTheme } from '../styling/index.js';

/**
 * Управление планами агента.
 *
 * План — это список шагов со статусами (pending/in_progress/done/skipped).
 * Хранится в ~/.mma/state/current-plan.json.
 *
 * Используется агентом для структурирования сложных задач (3+ шагов).
 *
 * @module tools/plan
 */

const PLAN_DIR = join(homedir(), '.mma', 'state');
const PLAN_FILE = join(PLAN_DIR, 'current-plan.json');

/** Шаг плана */
export interface PlanStep {
  id: number;
  title: string;
  status: 'pending' | 'in_progress' | 'done' | 'skipped';
}

/** План агента */
export interface Plan {
  name: string;
  steps: PlanStep[];
  createdAt: string;
  updatedAt: string;
}

/** Создаёт директорию для планов если не существует */
function ensureDir(): void {
  if (!existsSync(PLAN_DIR)) mkdirSync(PLAN_DIR, { recursive: true });
}

/** Загружает текущий план из файла */
function loadPlan(): Plan | null {
  try {
    if (existsSync(PLAN_FILE)) {
      return JSON.parse(readFileSync(PLAN_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

/** Сохраняет план в файл */
function savePlan(plan: Plan): void {
  ensureDir();
  writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2), 'utf-8');
}

/** Создаёт новый план с указанными шагами */
export function createPlan(name: string, steps: string[]): string {
  const plan: Plan = {
    name,
    steps: steps.map((title, i) => ({
      id: i + 1,
      title,
      status: 'pending' as const,
    })),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  savePlan(plan);
  return formatPlan(plan);
}

/** Обновляет статус шага плана */
export function updatePlanStep(stepId: number, status: PlanStep['status']): string {
  const plan = loadPlan();
  if (!plan) return 'No active plan. Create one first with plan(create).';

  const step = plan.steps.find(s => s.id === stepId);
  if (!step) return `Step ${stepId} not found.`;

  step.status = status;
  plan.updatedAt = new Date().toISOString();
  savePlan(plan);
  return formatPlan(plan);
}

/** Показывает текущий план с прогрессом */
export function showPlan(): string {
  const plan = loadPlan();
  if (!plan) return 'No active plan. Create one with plan(create).';
  return formatPlan(plan);
}

/** Удаляет текущий план */
export function clearPlan(): string {
  const plan = loadPlan();
  if (!plan) return 'No active plan to clear.';
  try { require('node:fs').unlinkSync(PLAN_FILE); } catch { /* ignore */ }
  return `Plan "${plan.name}" cleared.`;
}

/** Возвращает количество незавершённых шагов плана (0 = все готово или нет плана) */
export function getPlanPendingCount(): number {
  const plan = loadPlan();
  if (!plan) return 0;
  return plan.steps.filter(s => s.status !== 'done' && s.status !== 'skipped').length;
}

/** Форматирует план для отображения (с иконками и прогрессом) */
function formatPlan(plan: Plan): string {
  const theme = getTheme();
  const done = plan.steps.filter(s => s.status === 'done').length;
  const total = plan.steps.length;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;

  const lines: string[] = [];
  lines.push(`${theme.heading(`Plan: ${plan.name}`)} [${done}/${total} ${progress}%]`);
  lines.push('');

  for (const step of plan.steps) {
    const icon = theme.stepIcon(step.status);
    lines.push(`  ${icon} ${theme.dim(String(step.id))}. ${step.title}`);
  }

  return lines.join('\n');
}

/** Парсит аргументы команды plan (create, done, progress, show, clear) */
export function parsePlanCommand(args: string): { action: string; params: string[] } {
  const parts = args.trim().split(/\s+/);
  const action = parts[0] || 'show';
  const params = parts.slice(1);
  return { action, params };
}
