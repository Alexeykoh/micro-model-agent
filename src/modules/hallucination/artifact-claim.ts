/**
 * Artifact-claim checks (ses_mul5pepu_9mdq90): qwen3.5-9b wrote fizzbuzz.py,
 * failed to run it (python blacklisted), then pasted an "expected" program
 * output with wrong values as if it ran; it also wrote schema.drawio with a
 * malformed `<diagram/>` + stray `</diagram>` and claimed "valid XML".
 * The success-claim check only fires on error signals in tool outputs, so
 * both passed silently.
 *
 * Two deterministic checks (regex + disk state resolved by the caller, no
 * LLM):
 * - `checkArtifactClaims`: the answer presents a file as created/valid, but
 *   on disk it is missing or fails parsing.
 * - `checkUnverifiedOutput`: the answer frames a code block as actual program
 *   output, but no tool in the evidence window successfully executed anything.
 *
 * Pure functions — the disk state (`ArtifactState[]`) is resolved by the
 * caller (agent loop, which owns baseDir), keeping this module testable.
 * Precision is recall-leaning like success-claim.ts: a false positive costs
 * one bounded re-check iteration, a false negative is the status quo.
 */

import type { ClaimContradiction, ClaimToolEvidence } from "./success-claim";

export interface ArtifactState {
  /** Workspace-relative path as mentioned in the answer. */
  path: string;
  /** The file exists on disk under baseDir. */
  exists: boolean;
  /** Parser error for a machine-checkable format (JSON/XML family), if any. */
  parseError?: string;
  /** What the answer claims about it (for the retry message), if detected. */
  claim?: string;
}

const WORD = "A-Za-zА-Яа-яЁё0-9_";
const wb = (body: string): RegExp =>
  new RegExp(`(?<![${WORD}])(?:${body})(?![${WORD}])`, "i");

/** Success language about a file (any locale the agent speaks). */
const ARTIFACT_SUCCESS_RE = wb(
  "создан[а-яё]*|записан[а-яё]*|сохран[её]н[а-яё]*|готов[а-яё]*|валид[а-яё]*|проверен[а-яё]*|существует|valid(?:ated)?|verified|checked|written|saved|created|exists?|ready",
);

/**
 * Which success word (if any) the answer uses near the file mention.
 * Returns the matched word for a precise retry message.
 */
function claimedAs(response: string, path: string): string | null {
  const idx = response.toLowerCase().indexOf(path.toLowerCase());
  if (idx === -1) return null;
  // Look at a window around the mention — the claim usually sits in the
  // same sentence ("Файл schema.drawio создан и валиден").
  const window = response.slice(Math.max(0, idx - 160), idx + path.length + 160);
  const m = window.match(ARTIFACT_SUCCESS_RE);
  return m ? m[0] : null;
}

/**
 * Returns a contradiction when the answer presents a resolved artifact as
 * created/valid while it is missing or unparseable on disk.
 */
export function checkArtifactClaims(
  response: string,
  artifacts: ArtifactState[],
): (ClaimContradiction & { path: string }) | null {
  if (!response) return null;
  for (const a of artifacts) {
    const claim = a.claim ?? claimedAs(response, a.path);
    if (!claim) continue;
    if (!a.exists) {
      return {
        tool: "disk",
        path: a.path,
        snippet: `${a.path}: file not found on disk, claimed "${claim}"`,
      };
    }
    if (a.parseError) {
      return {
        tool: "disk",
        path: a.path,
        snippet: `${a.path}: ${a.parseError}, claimed "${claim}"`,
      };
    }
  }
  return null;
}

/** Phrases framing a code block as ACTUAL execution output (not an example). */
const OUTPUT_AS_RESULT_RE = wb(
  "вывод программы|вывод команды|результат запуска|результат выполнения|program output|command output|execution result|запустил[а-яё]*.*вывод|покажу вывод|actual output",
);

/** Hedging that downgrades the block to an expectation/example — honest. */
const OUTPUT_HEDGE_RE = wb(
  "ожидаем[а-яё]*|expected|пример[а-яё]*|example|для справки|sample|например|предполагаем[а-яё]*|должен быть|should be",
);

const FENCE_RE = /```/;

/** Tool names whose success means "something actually executed". */
const EXEC_TOOLS = new Set(["bash", "process_wait", "pipeline_run"]);

/**
 * Returns a contradiction when the answer shows output as if produced by a
 * run, but no execution tool succeeded in the evidence window.
 */
export function checkUnverifiedOutput(
  response: string,
  tools: ClaimToolEvidence[],
): ClaimContradiction | null {
  if (!response || !OUTPUT_AS_RESULT_RE.test(response)) return null;
  if (OUTPUT_HEDGE_RE.test(response)) return null;
  if (!FENCE_RE.test(response)) return null;
  const recent = tools.filter((t) => t.text?.trim()).slice(-10);
  const executed = recent.some((t) => t.ok === true && t.name !== undefined && EXEC_TOOLS.has(t.name));
  if (executed) return null;
  const m = response.match(OUTPUT_AS_RESULT_RE);
  return {
    tool: "no-execution",
    snippet: `claimed "${m?.[0] ?? "output"}" with no successful execution tool in evidence`,
  };
}
