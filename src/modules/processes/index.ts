// Публичная поверхность фоновых процессов: реестр, килл дерева и kill-колбэки тулов.
export { registerKillable, unregisterKillable, killByCallId } from "./runner";
export { processRegistry } from "./registry";
export { killTree } from "./kill-tree";
export type { ManagedProcess, ProcessStatus } from "./registry";
