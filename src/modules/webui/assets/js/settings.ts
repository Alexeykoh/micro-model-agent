// Settings barrel. The implementation is split by concern under `./settings/`:
//   write     — `postConfig` funnel, composer selectors, config/model loaders
//   panels    — generic section rendering + ui/security/memory/skills/plugins panels
//   providers — provider form + model & provider panel
//   modal     — settings overlay, tablist, `renderSettings`, open/close/escape
//   subdialog — the shared nested "edit one thing" dialog
//   search    — panel/key search
//   form      — tiny form primitives (inputs/selects/checkboxes)
// `app.js` imports the public surface from here.
export * from "./settings/write.js";
export * from "./settings/theme.js";
export * from "./settings/panels.js";
export * from "./settings/providers.js";
export * from "./settings/modal.js";
export * from "./settings/subdialog.js";
export * from "./settings/search.js";
