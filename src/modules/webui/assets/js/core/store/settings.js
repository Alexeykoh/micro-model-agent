// Settings slice of the shared frontend state: server config/registry, model
// and provider lists, memory/skills/plugins payloads and the open sub-dialog
// forms. Owned by `settings/**`; aliased on the composed `S` (`./index.js`).
export const settings = {
  config: null,
  registry: [],
  webToken: null,
  models: [],
  memory: undefined,
  skills: undefined,
  pluginsData: undefined,
  providers: undefined,
  providerPresets: [],
  providerForm: null,
  mcpForm: null,
  lspForm: null,
  lsp: undefined,
};