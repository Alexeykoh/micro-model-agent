// Канал-синглтон процесса (вынесено из `channel.ts`, правило ≤300).
import { defaultOutputBus } from "./bus";
import { OutputChannel } from "./channel";

let defaultChannel: OutputChannel | null = null;

/** Канал-синглтон текущего процесса. */
export function getDefaultChannel(): OutputChannel {
  if (!defaultChannel) defaultChannel = new OutputChannel(defaultOutputBus);
  return defaultChannel;
}

/** Сброс синглтона (изоляция тестов). */
export function resetDefaultChannel(): void {
  defaultChannel?.dispose();
  defaultChannel = null;
}
