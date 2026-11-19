// Публичная поверхность плагинов: менеджер, тип плагина и read-модель записей.
export { PluginManager } from "./manager";
export type { PluginInfo, RegisterResult } from "./manager";
export type { AgentPlugin } from "./types";
export { PLUGIN_PERMISSIONS } from "./records";
export type { PluginLoadFailure, PluginProvides, PluginRecord } from "./records";
