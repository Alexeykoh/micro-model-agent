/**
 * Контракт демона для web-адаптера (split W4).
 *
 * `RemoteHost` удовлетворяет ему структурно; web-модуль не импортирует
 * `modules/daemon`, чтобы не появлялось ребро module→module.
 */
import type { Host } from "../../core/host";

/** Дополнительные методы, которые нужны браузерной поверхности. */
export interface WebDaemonHost extends Host {
  pause(): Promise<void>;
  resume(): Promise<void>;
  answer(id: string, value: unknown): Promise<void>;
  setSessionId(sessionId: string): void;
  dispose(): void;
}
