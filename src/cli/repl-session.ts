/**
 * Жизненный цикл сессии REPL: синк вывода сессии, `/reload` и останов.
 *
 * Вынесено из `repl.ts` (правило 6): всё, что меняет mutable-поля инстанса
 * (агент, менеджеры модулей, синк), но не ввод-вывод кадра.
 */
import { join } from "path";
import { unloadPluginsForReboot, type PluginManager } from "../modules/plugins/manager";
import { projectMmaDir, globalPluginsDir } from "../config/paths";
import { SessionOutputSink, defaultOutputBus } from "../output";
import { saveHistory, type ReplHistoryHost } from "./repl-history";
import type { LineInput } from "../ui/line-editor";
import type { Agent } from "../core/agent";
import type { AppConfig } from "../config/types";
import type { Logger } from "../logger/app-logger";
import type { SessionManager } from "../modules/session/manager";
import type { SkillsModule } from "../modules/skills/module";
import type { ExecutionModule } from "../modules/execution/module";
import type { PromptIO } from "../tools/prompt-io";

/** Поля `Repl`, нужные жизненному циклу. */
export interface ReplLifecycleHost extends ReplHistoryHost {
  running: boolean;
  rl: LineInput;
  agent: Agent;
  config: AppConfig;
  configDir: string;
  baseDir: string;
  logger?: Logger;
  sessionManager?: SessionManager;
  skillsModule?: SkillsModule;
  pluginManager?: PluginManager;
  execModule?: ExecutionModule;
  promptIO: PromptIO;
  sessionOutput?: SessionOutputSink;
  setupCompleter(): void;
  attachHostBridge(pm?: PluginManager): void;
}

/** (Пере)привязка синка вывода сессии после конструктора или `/reload`. */
export function bindSessionOutput(host: ReplLifecycleHost): void {
  host.sessionOutput?.dispose();
  host.sessionOutput = host.sessionManager
    ? new SessionOutputSink(defaultOutputBus, host.sessionManager)
    : undefined;
}

/**
 * Перезагрузка агента и модулей (команда /reload). Живёт здесь, а не в
 * repl-commands, потому что меняет mutable-поля класса — команда через
 * интерфейс только вызывает `ctx.reload()`, не ломая readonly-контракт.
 */
export async function reload(host: ReplLifecycleHost): Promise<void> {
  const { loadConfig } = await import("../config/config");
  const { bootstrap } = await import("../core/bootstrap");

  host.agent.shutdown();

  // Старые плагины выгружаются с `onUnload` (иначе их серверы переживут
  // пересборку), а кэш модулей сбрасывается — иначе новый bootstrap получил
  // бы прежние версии файлов из `require`.
  if (host.pluginManager) {
    unloadPluginsForReboot(
      host.pluginManager,
      {
        globalPluginsDir: globalPluginsDir(),
        projectPluginsDir: join(projectMmaDir(host.baseDir), "plugins"),
      },
      host.logger,
    );
  }

  const projectConfigPath = join(host.baseDir, ".mmrc");
  const { config: freshConfig } = loadConfig({
    configDir: host.configDir,
    projectConfigPath,
  });
  Object.assign(host.config, freshConfig);

  const result = await bootstrap(host.configDir, host.baseDir, false, false);
  host.agent = result.agent;
  // Переустанавливаем промпт-поверхность на свежезабутстрапленного агента: замыкание
  // `askViaEditor` этого REPL принадлежит всё ещё этому инстансу.
  host.agent.setPromptIO?.(host.promptIO);
  host.sessionManager = result.sessionManager;
  host.skillsModule = result.skillsModule;
  host.pluginManager = result.pluginManager;
  host.execModule = result.execModule;
  bindSessionOutput(host);

  // У свежего PluginManager моста нет — перерегистрируем, иначе плагины вроде
  // web-ui молча теряют управление агентом.
  host.attachHostBridge(result.pluginManager);

  host.setupCompleter();
}

/** Останов REPL: сейв истории, шатдаун агента, закрытие лога сессии. */
export function stop(host: ReplLifecycleHost): void {
  host.running = false;
  saveHistory(host);
  host.agent.shutdown();
  host.sessionOutput?.dispose();
  host.sessionOutput = undefined;
  // Закрываем лог сессии на останове REPL.
  host.logger?.closeSessionLog();
  host.rl.close();
}
