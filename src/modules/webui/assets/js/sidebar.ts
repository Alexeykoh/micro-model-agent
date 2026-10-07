// Sidebar (Session / Map / Trace / LSP) for `mma web` — thin public barrel.
// Logic lives in `./sidebar/*.js`; this file keeps the `js/sidebar.js` entry
// (app.js / tabs.js import from here). Leaf module: the frontend DAG stays
// acyclic (app → sidebar → {dom,i18n,format,store,api}).
// Design: docs/specs/2026-09-30-webui-sidebar-tabs-design.md,
//         docs/specs/2026-10-02-lsp-doctor-design.md (§12).
export * from "./sidebar/core.js";
export * from "./sidebar/trace.js";
export * from "./sidebar/map.js";
export * from "./sidebar/lsp.js";
export * from "./sidebar/files.js";
export * from "./sidebar/plugins.js";
