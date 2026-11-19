// Memory quality gate config (spec 2026-11-03-memory-validator-design).
export interface MemoryValidatorConfig {
  enabled: boolean;
  minChars: number;
  minWords: number;
  similarityThreshold: number;
}
