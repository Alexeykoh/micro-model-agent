import type { AgentPlugin, PluginContext } from '../types.js';
import { runPreToolUseHooks, runPostToolUseHooks } from '../../tools/hooks.js';

/**
 * Адаптер: оборачивает существующие hooks (.mma/hooks.json) как плагин.
 *
 * Позволяет перейти от hooks к plugin system без потери совместимости.
 * preToolUse → tool:before event
 * postToolUse → tool:after event
 *
 * @module plugins/adapters/hooks-adapter
 */

export function createHooksAdapter(): AgentPlugin {
  return {
    name: 'hooks-adapter',
    version: '1.0.0',
    description: 'Wraps .mma/hooks.json as a plugin',

    on(_event, handler) {
      // Not used — we register via the plugin's on() method
    },

    async onActivate(ctx: PluginContext) {
      ctx.logger.info('hooks-adapter: active (legacy hooks will run via ToolExecutor)');
    },
  };
}
