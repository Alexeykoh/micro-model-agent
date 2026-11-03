/**
 * `Host`-поверхность REPL и плагинный мост: busy-предикат, submit/interrupt,
 * подписка на шину вывода и снапшот состояния.
 *
 * Вынесено из `repl.ts` (правило 6). Мост один: и `Host`-методы, и плагины
 * идут тем же run-путём, что и терминальный ввод.
 */
import { createHostBridge } from "../core/host";
import type { HostBridge, HostBridgeSubmitOptions } from "../modules/types";
import type { HostStateSnapshot } from "../core/host";
import type { OutputEvent } from "../output/types";
import { defaultOutputBus } from "../output";
import { planSnapshotFromModule, adaptActivePlan } from "../core/host-plan";
import type { Agent } from "../core/agent";
import type { AppConfig } from "../config/types";
import type { PluginManager } from "../modules/plugins/manager";
import type { SessionManager } from "../modules/session/manager";
import type { ExecutionModule } from "../modules/execution/module";

/** Поля `Repl`, нужные `Host`-поверхности. */
export interface ReplHostHost {
  hostBridge?: HostBridge;
  pluginManager?: PluginManager;
  agentRunning: boolean;
  agent: Agent;
  config: AppConfig;
  sessionManager?: SessionManager;
  execModule?: ExecutionModule;
  runAgent(input: string): Promise<void>;
}

/** (Пере)аттач плагинного HostBridge. Зовётся в конструкторе и после того, как
 *  /reload заменил PluginManager: без этого перезагруженный web-ui плагин
 *  молча теряет способность сабмитить сообщения. */
export function attachHostBridge(host: ReplHostHost, pm?: PluginManager): void {
  const manager = pm ?? host.pluginManager;
  if (!manager) return;
  host.hostBridge ??= getHostBridge(host);
  manager.setHostBridge(host.hostBridge);
}

/** Строит HostBridge поверх обычного run-пути этого REPL. */
export function buildHostBridge(host: ReplHostHost): HostBridge {
  return createHostBridge({
    isBusy: () => host.agentRunning,
    addPendingImage: (url) => {
      host.agent.contextManager?.addPendingImage?.({
        type: "image_url",
        image_url: { url },
      });
    },
    runAgent: (text) => host.runAgent(text),
    interruptRun: () => host.agent.shutdown(),
  });
}

/** Лениво резолвит общий мост, чтобы `Host`-методы работали без плагинов. */
export function getHostBridge(host: ReplHostHost): HostBridge {
  host.hostBridge ??= buildHostBridge(host);
  return host.hostBridge;
}

/** Host/HostBridge: true, пока агент крутит ход. */
export function isBusy(host: ReplHostHost): boolean {
  return host.agentRunning;
}

/** Host/HostBridge: сабмит через общий мост (тот же run-путь). */
export function submit(
  host: ReplHostHost,
  text: string,
  opts?: HostBridgeSubmitOptions,
): Promise<unknown> {
  return getHostBridge(host).submit(text, opts);
}

/** Host/HostBridge: прерывание текущего прогона (в idle — no-op). */
export function interrupt(host: ReplHostHost): void {
  getHostBridge(host).interrupt();
}

/** Host/HostBridge: подписка на общую шину вывода. */
export function subscribeOutput(fn: (ev: OutputEvent) => void): () => void {
  return defaultOutputBus.subscribe(fn);
}

/** Host: снапшот план/сессия/модель для UI-поверхностей. */
export function getState(host: ReplHostHost): HostStateSnapshot {
  const meta = host.sessionManager?.getActiveMeta();
  return {
    busy: host.agentRunning,
    sessionId: meta?.id,
    sessionName: meta?.name,
    model: host.config.model,
    provider: host.config.provider?.active,
    plan: planSnapshotFromModule(adaptActivePlan(host.execModule?.getActivePlan())),
  };
}
