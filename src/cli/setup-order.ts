/**
 * Compatibility shim: the wizard's config-writing logic now lives in
 * `src/modules/setup/apply.ts` so the browser wizard shares it. Re-exported
 * here to keep the terminal import path (and its tests) unchanged.
 */
export { applyAnswersToConfig, SECURITY_BASH_BLOCKLIST } from "../modules/setup/apply";
