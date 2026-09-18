import type { OutputEvent } from "./types";

/**
 * Per-plugin output subscription registry. A plugin may (re)subscribe on
 * session start and explicitly detach on session end; the bridge keeps at most
 * one subscription per plugin id so a reload cannot leak listeners.
 */
export class PluginOutputBridge {
  private readonly unsubs = new Map<string, () => void>();

  constructor(private bus: { subscribe(fn: (ev: OutputEvent) => void): () => void }) {}

  subscribe(pluginId: string, fn: (ev: OutputEvent) => void): void {
    this.unsubscribe(pluginId);
    this.unsubs.set(pluginId, this.bus.subscribe(fn));
  }

  unsubscribe(pluginId: string): void {
    this.unsubs.get(pluginId)?.();
    this.unsubs.delete(pluginId);
  }

  dispose(): void {
    for (const un of this.unsubs.values()) un();
    this.unsubs.clear();
  }
}
