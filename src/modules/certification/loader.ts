import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { BUILTIN_SCENARIOS } from "./scenarios";
import type { CertScenario, CertTag } from "./types";

const TAGS: CertTag[] = ["core", "security", "image", "network", "browser"];

const CHECK_TYPES = [
  "fileExists",
  "fileNotExists",
  "dirExists",
  "fileContent",
  "fileRegex",
  "exitCode",
  "outputContains",
];

export interface LoadResult {
  scenarios: CertScenario[];
  errors: string[];
}

export function validateScenario(s: CertScenario): string[] {
  const errors: string[] = [];
  const isSkip = s.mode === "skip";
  if (!s.id || !s.title || (!isSkip && !s.prompt)) {
    errors.push(`[${s.id ?? "?"}] missing id, title or prompt`);
  }
  if (!Array.isArray(s.tags) || s.tags.length === 0) {
    errors.push(`[${s.id}] tags required`);
  }
  for (const tag of s.tags) {
    if (!TAGS.includes(tag)) errors.push(`[${s.id}] unknown tag: ${tag}`);
  }
  if (s.mode !== "run" && s.mode !== "skip") {
    errors.push(`[${s.id}] mode must be run or skip`);
  }
  if (!Array.isArray(s.checks) || (!isSkip && s.checks.length === 0)) {
    errors.push(`[${s.id}] at least one check required`);
  }
  for (const c of s.checks) {
    if (!CHECK_TYPES.includes(c.type)) {
      errors.push(
        `[${s.id}] unknown check type: ${(c as { type: string }).type}`,
      );
    }
    if (
      c.type === "fileContent" &&
      c.contains === undefined &&
      c.equals === undefined
    ) {
      errors.push(`[${s.id}] fileContent needs contains or equals`);
    }
  }
  if (s.reps !== undefined && (!Number.isInteger(s.reps) || s.reps < 1)) {
    errors.push(`[${s.id}] reps must be a positive integer`);
  }
  if (
    s.passThreshold !== undefined &&
    (!Number.isInteger(s.passThreshold) || s.passThreshold < 1)
  ) {
    errors.push(`[${s.id}] passThreshold must be a positive integer`);
  }
  if (
    s.passThreshold !== undefined &&
    s.reps !== undefined &&
    s.passThreshold > s.reps
  ) {
    errors.push(`[${s.id}] passThreshold > reps (must be <= reps)`);
  }
  return errors;
}

export function loadScenarios(userDir?: string): LoadResult {
  const errors: string[] = [];
  const scenarios: CertScenario[] = [];

  for (const s of BUILTIN_SCENARIOS) {
    const errs = validateScenario(s);
    if (errs.length > 0) errors.push(...errs);
    else scenarios.push(s);
  }

  if (userDir && existsSync(userDir)) {
    for (const file of readdirSync(userDir)) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      try {
        const raw = readFileSync(join(userDir, file), "utf-8");
        const data = parseYaml(raw);
        const parsed = normalizeScenario(data, file);
        const errs = validateScenario(parsed);
        if (errs.length > 0) errors.push(...errs);
        else scenarios.push(parsed);
      } catch (e: any) {
        errors.push(`[${file}] failed to parse: ${e.message}`);
      }
    }
  }

  return { scenarios, errors };
}

function normalizeScenario(data: unknown, file: string): CertScenario {
  const d = (data ?? {}) as Record<string, unknown>;
  return {
    id: String(d.id ?? file),
    title: String(d.title ?? d.id ?? file),
    tags: Array.isArray(d.tags) ? (d.tags as CertTag[]) : [],
    mode: d.mode === "skip" ? "skip" : "run",
    prompt: String(d.prompt ?? ""),
    reps: typeof d.reps === "number" ? d.reps : undefined,
    passThreshold:
      typeof d.passThreshold === "number" ? d.passThreshold : undefined,
    fixtures: Array.isArray(d.fixtures)
      ? (d.fixtures as CertScenario["fixtures"])
      : undefined,
    checks: Array.isArray(d.checks) ? (d.checks as CertScenario["checks"]) : [],
    skipReason: typeof d.skipReason === "string" ? d.skipReason : undefined,
  };
}

export function filterByTags(
  scenarios: CertScenario[],
  tags: CertTag[],
): CertScenario[] {
  if (!tags || tags.length === 0) {
    return scenarios.filter((s) => s.tags.includes("core"));
  }
  return scenarios.filter((s) => s.tags.some((t) => tags.includes(t)));
}
