export type ChangeOp = "write" | "delete" | "move" | "undo" | "evicted";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

export function assertSha256(
  value: unknown,
  label = "blob",
): asserts value is string {
  if (!isSha256(value)) throw new Error(`Invalid SHA-256 ${label} hash`);
}

export interface ChangeEntry {
  v: 1;
  id: string;
  ts: string;
  turn: number;
  tool: string;
  callId: string;
  op: ChangeOp;
  path: string;
  pathAbs: string;
  before: string | null;
  after: string | null;
  bytes: number;
  mode?: number;
  to?: string;
  toBefore?: string | null;
  targetId?: string;
  skipped?: "too-large" | "evicted" | "unsupported";
}

export interface UndoItem {
  path: string;
  ok: boolean;
  reason?: string;
}

export interface UndoResult {
  ok: boolean;
  message: string;
  items: UndoItem[];
  diff?: string;
}

export interface ListOptions {
  sessionId: string;
  baseDir: string;
  path?: string;
  limit?: number;
}

export interface UndoOptions {
  sessionId: string;
  baseDir: string;
  path?: string;
  steps?: number;
  turn?: number;
  force?: boolean;
}

const CHANGE_OPS: ReadonlySet<string> = new Set([
  "write",
  "delete",
  "move",
  "undo",
  "evicted",
]);
const SKIPPED_REASONS: ReadonlySet<string> = new Set([
  "too-large",
  "evicted",
  "unsupported",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  );
}

function isChangeOp(value: unknown): value is ChangeOp {
  return typeof value === "string" && CHANGE_OPS.has(value);
}

function isNullableSha256(value: unknown): value is string | null {
  return value === null || isSha256(value);
}

function isSkippedReason(
  value: unknown,
): value is NonNullable<ChangeEntry["skipped"]> {
  return typeof value === "string" && SKIPPED_REASONS.has(value);
}

/** Validate untrusted journal data before it reaches capture/undo logic. */
export function parseChangeEntry(value: unknown): ChangeEntry | null {
  if (!isRecord(value) || value.v !== 1) return null;
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.ts) ||
    Number.isNaN(Date.parse(value.ts)) ||
    !isSafeNonNegativeInteger(value.turn) ||
    !isNonEmptyString(value.tool) ||
    !isNonEmptyString(value.callId) ||
    !isChangeOp(value.op) ||
    !isNonEmptyString(value.path) ||
    !isNonEmptyString(value.pathAbs) ||
    !isNullableSha256(value.before) ||
    !isNullableSha256(value.after) ||
    !isSafeNonNegativeInteger(value.bytes)
  ) {
    return null;
  }
  if (value.mode !== undefined && !isSafeNonNegativeInteger(value.mode)) {
    return null;
  }
  if (value.to !== undefined && !isNonEmptyString(value.to)) return null;
  if (value.toBefore !== undefined && !isNullableSha256(value.toBefore)) {
    return null;
  }
  if (value.targetId !== undefined && !isNonEmptyString(value.targetId)) {
    return null;
  }
  if (value.skipped !== undefined && !isSkippedReason(value.skipped)) {
    return null;
  }
  return {
    v: 1,
    id: value.id,
    ts: value.ts,
    turn: value.turn,
    tool: value.tool,
    callId: value.callId,
    op: value.op,
    path: value.path,
    pathAbs: value.pathAbs,
    before: value.before,
    after: value.after,
    bytes: value.bytes,
    ...(value.mode !== undefined ? { mode: value.mode } : {}),
    ...(value.to !== undefined ? { to: value.to } : {}),
    ...(value.toBefore !== undefined ? { toBefore: value.toBefore } : {}),
    ...(value.targetId !== undefined ? { targetId: value.targetId } : {}),
    ...(value.skipped !== undefined ? { skipped: value.skipped } : {}),
  };
}
