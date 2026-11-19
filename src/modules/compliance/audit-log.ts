/**
 * Tamper-evident audit log (P2 compliance, EU AI Act Art.12/15).
 * Append-only JSONL with hash chain: each entry carries `prev` (hash of
 * previous entry) and `sig` (HMAC-SHA256 over canonical payload with a
 * process-local key file). Verification walks the chain; any edit,
 * deletion or reorder breaks `prev`/`sig` and is reported.
 */
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";

export interface AuditEntry {
  ts: string;
  kind: string;
  sessionId?: string;
  payload: unknown;
  prev: string;
  sig: string;
}

const GENESIS = "0".repeat(64);

export function getAuditKey(keyDir: string): string {
  const path = join(keyDir, "audit.key");
  if (existsSync(path)) return readFileSync(path, "utf-8").trim();
  const key = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, key, { encoding: "utf-8", mode: 0o600 });
  return key;
}

function sign(key: string, entry: Omit<AuditEntry, "sig">): string {
  return createHmac("sha256", key)
    .update(JSON.stringify({ ts: entry.ts, kind: entry.kind, sessionId: entry.sessionId, payload: entry.payload, prev: entry.prev }))
    .digest("hex");
}

export function appendAudit(logPath: string, keyDir: string, kind: string, payload: unknown, sessionId?: string): AuditEntry {
  const key = getAuditKey(keyDir);
  const prev = lastHash(logPath);
  const base = { ts: new Date().toISOString(), kind, sessionId, payload, prev };
  const entry: AuditEntry = { ...base, sig: sign(key, base) };
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf-8");
  return entry;
}

function lastHash(logPath: string): string {
  if (!existsSync(logPath)) return GENESIS;
  const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
  if (lines.length === 0) return GENESIS;
  try {
    const last = JSON.parse(lines[lines.length - 1]!) as AuditEntry;
    return last.sig ?? GENESIS;
  } catch {
    return GENESIS;
  }
}

export interface VerifyResult {
  valid: boolean;
  entries: number;
  brokenAt?: number;
}

/** Walk the hash chain; fail at the first broken link (tamper evidence). */
export function verifyAudit(logPath: string, keyDir: string): VerifyResult {
  const key = getAuditKey(keyDir);
  if (!existsSync(logPath)) return { valid: true, entries: 0 };
  const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let entry: AuditEntry;
    try {
      entry = JSON.parse(lines[i]!) as AuditEntry;
    } catch {
      return { valid: false, entries: lines.length, brokenAt: i };
    }
    if (entry.prev !== prev) return { valid: false, entries: lines.length, brokenAt: i };
    const { sig, ...base } = entry;
    if (sign(key, base) !== sig) return { valid: false, entries: lines.length, brokenAt: i };
    prev = entry.sig;
  }
  return { valid: true, entries: lines.length };
}
