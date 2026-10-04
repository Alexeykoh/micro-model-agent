// Shared frontend state barrel. The state is sliced by domain under
// `./core/store/` (feed/tabs/settings/session); this file re-exports the slices,
// the app-shell hooks registry and the path helpers.
export * from "./core/store/index.js";