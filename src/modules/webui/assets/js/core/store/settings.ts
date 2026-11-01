// Settings slice of the shared frontend state: server config/registry, model
// and provider lists, memory/skills/plugins payloads and the open sub-dialog
// forms. Owned by `settings/**`; aliased on the composed `S` (`./index.js`).
import type { Dict } from "./types.js";

export interface SettingsSlice {
  config: Dict | null;
  registry: Dict[];
  webToken: string | null;
  models: Dict[];
  /** Список моделей активного провайдера уже запрошен (даже если пуст). */
  modelsReady: boolean;
  /**
   * Модели записей провайдеров для страницы экспертов (`GET /api/models?provider=`).
   * `loading: true` — сервер ещё собирает список, страница перезапросит.
   */
  modelsByProvider: Record<string, { models: string[]; loading: boolean }>;
  memory: Dict | null | undefined;
  skills: Dict[] | null | undefined;
  pluginsData: Dict | null | undefined;
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
  modelsReady: false,
  modelsByProvider: {},
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
