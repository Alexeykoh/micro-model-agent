// Публичный фасад вывода: типы, шина, канал, стоки, машинный вывод.
export * from "./types";
export { moduleSource, toolSource, sourceLabel } from "./source";
export { OutputBus, defaultOutputBus } from "./bus";
export { formatEventLine } from "./format";
export { JsonOutputSink } from "./json-sink";
export { SessionOutputSink, type SessionLogSink } from "./session-sink";
export {
  OutputChannel,
  getDefaultChannel,
  resetDefaultChannel,
  type PromptSink,
  type OutputChannelOptions,
  type ChannelMode,
} from "./channel";
export { writeMachineJson, writeNonTtyLine } from "./machine";
