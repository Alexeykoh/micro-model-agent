import type { OutputRenderer, StatusInfo } from './renderer.js'

/**
 * Фабрика рендереров.
 *
 * Создаёт рендерер в зависимости от режима:
 * - readline (по умолчанию) — простой терминальный ввод
 * - ink — React-based рендерер с rich UI
 *
 * Режим выбирается через INK_MODE=1 или опцию mode.
 *
 * @module ui/index
 */

export interface SlashCommandInfo {
  name: string
  description: string
}

export type { OutputRenderer, StatusInfo } from './renderer.js'

/** Создаёт рендерер (readline или Ink в зависимости от режима) */
export async function createRenderer(
  commands?: SlashCommandInfo[],
  options?: { mode?: 'readline' | 'ink' }
): Promise<OutputRenderer> {
  const mode = options?.mode ||
    (process.env.INK_MODE === '1' ? 'ink' : 'readline');

  if (mode === 'ink') {
    const { InkRenderer } = await import('./ink/renderer.js');
    const r = new InkRenderer();
    if (commands) r.setCommands(commands);
    await r.start();
    return r;
  }

  const { ReadlineRenderer } = await import('./readline-renderer.js');
  const r = new ReadlineRenderer();
  if (commands) r.setCommands(commands);
  await r.start();
  return r;
}
