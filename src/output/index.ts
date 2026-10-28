// Публичный фасад вывода: типы, шина, канал, стоки, машинный вывод.
export * from "./types";
export { moduleSource, toolSource, sourceLabel, moduleOf } from "./source";
export { OutputBus, defaultOutputBus, setLogsToStderr } from "./bus";
export { formatEventLine } from "./format";
export { JsonOutputSink } from "./json-sink";
export { SessionOutputSink, type SessionLogSink } from "./session-sink";
export {
  OutputChannel,
  type PromptSink,
  type OutputChannelOptions,
  type ChannelMode,
} from "./channel";
export { getDefaultChannel, resetDefaultChannel } from "./default-channel";
export { writeMachineJson, writeNonTtyLine } from "./machine";
