// Settings slice of the shared frontend state: server config/registry, model
// and provider lists, memory/skills/plugins payloads and the open sub-dialog
// forms. Owned by `settings/**`; aliased on the composed `S` (`./index.js`).
import type { Dict } from "./types.js";

export interface SettingsSlice {
  config: Dict | null;
  registry: Dict[];
  webToken: string | null;
  models: Dict[];
  memory: Dict | undefined;
  skills: Dict | undefined;
  pluginsData: Dict | undefined;
  providers: Dict | undefined;
  providerPresets: Dict[];
  // biome-ignore lint/suspicious/noExplicitAny: opaque open-form state.
  providerForm: any;
  // biome-ignore lint/suspicious/noExplicitAny: opaque open-form state.
  mcpForm: any;
  lspForm: Dict | null;
  // biome-ignore lint/suspicious/noExplicitAny: opaque LSP payload.
  lsp: any;
}

export const settings: SettingsSlice = {
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
