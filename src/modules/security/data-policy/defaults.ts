/** Дефолты политики DLP `security.dataPolicy.*`. */
import type { DataPolicyConfig } from "./types";

/**
 * Базовый набор glob, не отправляемых внешнему провайдеру. Отражает
 * `protected-paths.ts` (always-on) как «супермножество» (D2). При пустом
 * `providerBlockGlobs` берётся этот список; `apiHiddenGlobs` добавляется всегда.
 */
export const DEFAULT_PROTECTED_GLOBS: readonly string[] = [
  ".git/",
  ".hg/",
  ".svn/",
  ".env",
  ".env.*",
  ".npmrc",
  ".netrc",
  ".git-credentials",
  ".gitconfig",
  "*.key",
  "*.pem",
  "*.p12",
  "*.pfx",
  "*.crt",
  "*.cer",
  "*.secret",
  "*.token",
];

/** Дефолтная политика (включается для офиса; loopback — доверенный). */
export const DEFAULT_DATA_POLICY: DataPolicyConfig = {
  // Включено по умолчанию: «важнейшее правило» держится на каркасе, не на модели.
  // Локальный (loopback) провайдер всё равно получает реальные пути.
  enabled: true,
  pathMode: "prefix",
  pseudonymize: true,
  egress: {
    paths: true,
    machine: true,
    env: true,
    pii: true,
    fileContent: true,
  },
  trustedHosts: [],
  apiHiddenGlobs: [],
  providerBlockGlobs: [],
  allowImagesToExternal: false,
  failClosed: true,
  minConfidence: 0.4,
};

/**
 * Итоговый список glob для внешнего egress: `providerBlockGlobs` (или дефолт)
 * ∪ `apiHiddenGlobs` (D2 — супермножество).
 */
export function effectiveProviderBlockGlobs(dp: DataPolicyConfig): string[] {
  const base = dp.providerBlockGlobs.length > 0 ? dp.providerBlockGlobs : DEFAULT_PROTECTED_GLOBS;
  return [...new Set([...base, ...dp.apiHiddenGlobs])];
}
