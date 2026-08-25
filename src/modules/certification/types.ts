export type CertTag = "core" | "security" | "image" | "network" | "browser" | "moe" | "shell" | "research";

export type CertCheck =
  | { type: "fileExists"; path: string }
  | { type: "fileNotExists"; path: string }
  | { type: "dirExists"; path: string }
  | { type: "fileContent"; path: string; contains?: string; equals?: string }
  | { type: "fileRegex"; path: string; pattern: string }
  | { type: "exitCode"; code?: number }
  | { type: "outputContains"; text: string };

export interface CertFixture {
  source: string;
  dest: string;
}

export interface CertScenario {
  id: string;
  title: string;
  tags: CertTag[];
  mode: "run" | "skip";
  prompt: string;
  reps?: number;
  passThreshold?: number;
  /** Per-rep timeout in ms. Slow multi-step scenarios on local reasoning models need more than the 300s default. */
  timeoutMs?: number;
  fixtures?: CertFixture[];
  checks: CertCheck[];
  skipReason?: string;
  /** Config overrides for this scenario. Merged into base config and written to sandbox. */
  config?: Record<string, unknown>;
}

export type ScenarioStatus = "pass" | "fail" | "error" | "skipped";

export interface ScenarioResult {
  id: string;
  title: string;
  status: ScenarioStatus;
  passed: number;
  of: number;
  error?: string;
  /** Diagnostic info from the sandbox: files created, plan state. Only on failure. */
  diagnostics?: string;
}

export interface SuiteSummary {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}

export interface CertificationEntry {
  model: string;
  providerUrl: string;
  mmaVersion: string;
  certifiedAt: string;
  suite: SuiteSummary;
  results: ScenarioResult[];
}

export interface CertManifest {
  version: 1;
  certifications: CertificationEntry[];
}

export type CertMark = "certified" | "stale" | "none";
