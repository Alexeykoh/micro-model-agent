/**
 * Single JSON body parser for the `mma web` POST handlers.
 *
 * Every POST endpoint used to repeat the same `JSON.parse` try/catch plus the
 * object-shape narrowing (~12 sites). Behavior contract, preserved exactly:
 * - malformed JSON → `null` (caller answers 400 `invalid JSON`);
 * - valid JSON that is not an object (e.g. `"str"`, `42`) → `{}` so the
 *   endpoint's own validation rejects it with its specific error;
 * - transport errors (overflow, socket) still reject and map via `readBodyError`.
 */
import type { IncomingMessage } from "node:http";
import { readBody } from "./util";

/** Parse a raw body; `null` means malformed JSON. Never throws. */
export function parseJsonBody(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * Read the request body (up to `cap`) and parse it as JSON.
 * Resolves to `null` on malformed JSON; rejects on transport errors.
 */
export function readJsonBody(
  req: IncomingMessage,
  cap: number,
): Promise<Record<string, unknown> | null> {
  return readBody(req, cap).then((raw) => parseJsonBody(raw));
}
