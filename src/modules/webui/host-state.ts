/**
 * Host snapshot projection for `mma web` (correction #6).
 *
 * Split out of `module.ts` (rule #1: ≤300 lines/file). Pure functions mapping
 * live module state into the `HostStateSnapshot` the sidebar renders; no
 * server, agent loop or SSE here. Re-exported from `module.ts` so existing
 * importers keep working.
 */
import type { AppConfig } from "../../config/types";
import type { AgentResult } from "../../core/types";
import type { HostStateSnapshot } from "../../core/host";
import type { SessionManager } from "../../modules/session/manager";
import type { ExecutionModule } from "../../modules/execution/module";
import { planSnapshotFromModule, adaptActivePlan } from "../../core/host-plan";
import type { UsageSnapshot } from "./state";

/**
 * Narrow inputs `buildHostState` reads. Kept separate from `WebUiDeps` so
 * the snapshot projection is testable without constructing a full `Agent`.
 */
export interface HostStateInput {
  config: AppConfig;
  sessionManager?: Pick<SessionManager, "getActiveMeta">;
  execModule?: Pick<ExecutionModule, "getActivePlan">;
  usage?: UsageSnapshot;
  contextProbe?: { model: string; actual: number } | null;
  workspace?: string;
  instructions?: { files: string[]; disabled: boolean };
  projectMap?: { indexed: boolean; files: number; symbols: number; tokens: number } | null;
}

/** Structural subset of the indexer module the sidebar needs (avoids a hard dep). */
export interface WebIndexer {
  buildIndex(): Promise<unknown>;
  stats(): { files: number; symbols: number; tokens: number } | null;
}

/**
 * Capture the usage-bearing subset of an `AgentResult` into a
 * {@link UsageSnapshot}. Undefined fields are omitted so a partial result never
 * overwrites a previously known value with a blank cell.
 */
export function captureUsage(result: AgentResult, fallbackLimit?: number): UsageSnapshot {
  const usage: UsageSnapshot = {};
  if (typeof result.contextUsed === "number") usage.contextUsed = result.contextUsed;
  const limit = typeof result.contextLimit === "number" ? result.contextLimit : fallbackLimit;
  if (typeof limit === "number") usage.contextLimit = limit;
  if (typeof result.totalCost === "number") usage.costUsd = result.totalCost;
  if (typeof result.compactionCount === "number") usage.compactionCount = result.compactionCount;
  if (result.cache) {
    if (typeof result.cache.hitRate === "number") usage.cacheHitRate = result.cache.hitRate;
    if (typeof result.cache.saved === "number") usage.cacheSaved = result.cache.saved;
  }
  if (typeof result.contextQuality === "number") usage.contextQuality = result.contextQuality;
  return usage;
}

/**
 * Resolve the plan snapshot to broadcast after a tool ends. Only `plan`/`todo`
 * tools mutate the active plan, so any other tool yields `null` (no event).
 * Pure so the hook is testable without booting the agent/server.
 */
export function planEventFor(
  toolName: string,
  execModule?: Pick<ExecutionModule, "getActivePlan">,
): HostStateSnapshot["plan"] | null {
  if (toolName !== "plan" && toolName !== "todo") return null;
  return planSnapshotFromModule(adaptActivePlan(execModule?.getActivePlan()));
}

/** Build the host snapshot from live module state (correction #6). */
export function buildHostState(deps: HostStateInput, busy: boolean): HostStateSnapshot {
  const meta = deps.sessionManager?.getActiveMeta();
  return {
    busy,
    sessionId: meta?.id,
    sessionName: meta?.name,
    model: deps.config.model,
    provider: deps.config.provider?.active,
    contextUsed: deps.usage?.contextUsed,
    contextLimit: deps.usage?.contextLimit,
    costUsd: deps.usage?.costUsd,
    compactionCount: deps.usage?.compactionCount,
    cacheHitRate: deps.usage?.cacheHitRate,
    contextQuality: deps.usage?.contextQuality,
    contextProbe: deps.contextProbe,
    workspace: deps.workspace,
    instructions: deps.instructions,
    projectMap: deps.projectMap ?? undefined,
    plan: planSnapshotFromModule(adaptActivePlan(deps.execModule?.getActivePlan())),
  };
}
