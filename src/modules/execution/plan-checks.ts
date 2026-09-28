/**
 * Step verification contracts ("checks").
 *
 * A check is a one-line contract declared per step at plan create/re-plan
 * time. Three prefixes:
 * - "file-exists:<path>" — hard-verified by StepVerifier on done;
 * - "command:<cmd>" — the exact command proving the step (self-certified);
 * - "manual:<text>" — eye-check for UI/visual work (self-certified).
 *
 * Pure helpers shared by the validator (module.parseChecks) and the
 * done-gate (plan-actions.updateStep).
 */

export type CheckKind = "file" | "command" | "manual";

export interface ParsedCheck {
  kind: CheckKind;
  /** Path after "file-exists:", command after "command:", text after "manual:". */
  target: string;
}

const PREFIXES: Array<{ prefix: string; kind: CheckKind }> = [
  { prefix: "file-exists:", kind: "file" },
  { prefix: "command:", kind: "command" },
  { prefix: "manual:", kind: "manual" },
];

/** Parse a check string. Returns null when the prefix is missing/unknown
 *  or the target is empty. */
export function parseCheck(check: string): ParsedCheck | null {
  const trimmed = check.trim();
  for (const { prefix, kind } of PREFIXES) {
    if (trimmed.toLowerCase().startsWith(prefix)) {
      const target = trimmed.slice(prefix.length).trim();
      if (!target) return null;
      return { kind, target };
    }
  }
  return null;
}

/** Whether a check string is a well-formed contract. */
export function isValidCheck(check: unknown): check is string {
  return typeof check === "string" && parseCheck(check) !== null;
}
