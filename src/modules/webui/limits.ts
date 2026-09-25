/**
 * Shared transport limits with no internal imports.
 *
 * Kept in its own module so `state.ts` and `util.ts` can both read
 * `MAX_BODY_BYTES` without importing each other (that edge was one of the two
 * webui import cycles).
 */
export const MAX_BODY_BYTES = 24 * 1024 * 1024;
