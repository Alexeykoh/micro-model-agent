import type { OutputRenderer, StatusInfo } from './renderer.js'

export interface SlashCommandInfo {
  name: string
  description: string
}

export type { OutputRenderer, StatusInfo } from './renderer.js'

export async function createRenderer(
  commands?: SlashCommandInfo[],
): Promise<OutputRenderer> {
  const { ReadlineRenderer } = await import('./readline-renderer.js');
  const r = new ReadlineRenderer();
  if (commands) r.setCommands(commands);
  await r.start();
  return r;
}
