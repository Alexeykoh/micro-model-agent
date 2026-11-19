/**
 * On-disk plan snapshot for the web-ui side panel.
 *
 * Plans are read straight from the plan store at <project>/.mma/plans/
 * (active.json, drafts/*.json, archive/*.json) — same layout trace-server
 * uses; no core changes needed. A 2s poll detects changes; plan/todo tool
 * calls and session start trigger an immediate refresh.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { broadcast, state } from "./state";
import type { WebUiState } from "./state";

/** Duck-typed against src/modules/execution/planner.ts Plan (disk format). */
export interface PlanLike {
  id?: string;
  name?: string;
  title?: string;
  createdAt?: string;
  steps: Array<{
    id: number;
    description: string;
    status: string;
    kind?: string;
    subtasks?: Array<{ id: number; text: string; done: boolean }>;
  }>;
}

export interface PlansSnapshot {
  active: PlanLike | null;
  drafts: PlanLike[];
  archived: PlanLike[];
}

function readPlanFile(path: string): PlanLike | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || !Array.isArray(raw.steps)) return null;
    return raw as PlanLike;
  } catch {
    return null;
  }
}

function listPlans(dir: string): PlanLike[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readPlanFile(join(dir, f)))
      .filter((p): p is PlanLike => p !== null)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  } catch {
    return [];
  }
}

export function readPlans(s: WebUiState): PlansSnapshot {
  if (!s.projectDir) return { active: null, drafts: [], archived: [] };
  const plansDir = join(s.projectDir, ".mma", "plans");
  return {
    active: readPlanFile(join(plansDir, "active.json")),
    drafts: listPlans(join(plansDir, "drafts")),
    archived: listPlans(join(plansDir, "archive")),
  };
}

function plansKey(plans: PlansSnapshot): string {
  return JSON.stringify({ a: plans.active, d: plans.drafts.length, r: plans.archived.length });
}

/** Broadcast the plans event only when the on-disk snapshot changed. */
export function emitPlans(kind: string, s: WebUiState = state): void {
  const plans = readPlans(s);
  const key = plansKey(plans);
  if (key === s.lastPlansKey) return;
  s.lastPlansKey = key;
  broadcast(
    {
      type: "plans",
      ts: Date.now(),
      kind,
      active: plans.active,
      drafts: plans.drafts,
      archived: plans.archived,
    },
    s,
  );
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startPlanPolling(s: WebUiState = state): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => emitPlans("poll", s), 2000);
  // Do not keep the process alive just for plan polling.
  (pollTimer as unknown as { unref?: () => void }).unref?.();
}

export function stopPlanPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
