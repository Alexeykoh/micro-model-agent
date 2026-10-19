/**
 * Публичная поверхность движка DLP `data-policy` (спека
 * `2026-10-19-corporate-data-policy-design.md`). Классификатор, псевдонимизация,
 * путь-политика и `EgressGuard` — единый контракт для E1/E2.
 */
export * from "./types";
export type { PolicyContext } from "./context";
export { classify, dedupe } from "./classify";
export { createGuard, EgressBlockedError, projectText } from "./guard";
export {
  createProviderEgressFactory,
  isLoopbackHost,
  isTrustedHost,
  providerHost,
} from "./egress-provider";
export type { ProviderEgressDeps, ProviderEntryRef } from "./egress-provider";
export { TokenMap, rehydrate, rehydrateArgs } from "./tokens";
export { enabledClasses, projectDeep } from "./project";
export {
  hiddenReason,
  matchAnyGlob,
  matchGlob,
  canonicalize,
  relativeTo,
} from "./path-policy";
export { detectPaths } from "./detectors/paths";
export { detectMachine } from "./detectors/machine";
export { detectSecrets } from "./detectors/secrets";
export { detectPii, detectRfPii, detectByPii } from "./detectors/pii";
export {
  ibanValid,
  innValid,
  luhnValid,
  ogrnValid,
  snilsValid,
} from "./detectors/pii/checksums";
