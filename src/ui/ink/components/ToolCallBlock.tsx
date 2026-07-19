import { Box, Text } from 'ink';
import { getInkTheme } from '../theme.js';

/**
 * Компонент отображения вызова инструмента.
 *
 * Показывает:
 * - Имя инструмента
 * - Превью аргументов
 * - Результат (с кодом возврата)
 * - Время выполнения
 *
 * @module ui/ink/components/ToolCallBlock
 */

/** Данные вызова инструмента */
export interface ToolCallData {
  name: string;
  args: string;
  result: string;
  time: string;
  exitCode?: number;
  subagentBuffer?: {
    lines: string[];
    toolCalls: { name: string; args: string; result: string }[];
  };
}

const SUBAGENT_TOOLS = new Set(['subagent']);

export function ToolCallBlock({ data }: { data: ToolCallData }) {
  const t = getInkTheme();
  const isSub = SUBAGENT_TOOLS.has(data.name);
  const borderColor = isSub ? 'yellow' : 'gray';
  const icon = isSub ? '⊞ ' : '';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} marginLeft={1} paddingX={1}>
      <Text>
        <Text bold={isSub} color={isSub ? 'yellow' : t.colors.toolName.color}>{icon}{isSub ? 'subagent' : `tool: ${data.name}`}</Text>
        <Text {...t.colors.dim}> ──</Text>
      </Text>
      {data.args ? (
        <Box marginLeft={1}>
          <Text {...t.colors.dim}>{data.args.slice(0, 120)}{data.args.length > 120 ? '...' : ''}</Text>
        </Box>
      ) : null}
      {/* Отображение буфера субагента */}
      {data.subagentBuffer ? (
        <Box flexDirection="column" marginLeft={1} marginTop={1}>
          {data.subagentBuffer.toolCalls.map((tc, i) => (
            <Box key={i} flexDirection="column">
              <Text {...t.colors.dim}>  [{tc.name}] {tc.args.slice(0, 80)}{tc.args.length > 80 ? '...' : ''}</Text>
              {tc.result ? (
                <Text color="green">    {tc.result.slice(0, 150)}{tc.result.length > 150 ? '...' : ''}</Text>
              ) : null}
            </Box>
          ))}
          {data.subagentBuffer.lines.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              {data.subagentBuffer.lines.slice(-15).map((line, i) => (
                <Text key={i} {...t.colors.dim}>{line.slice(0, 120)}{line.length > 120 ? '...' : ''}</Text>
              ))}
            </Box>
          ) : null}
        </Box>
      ) : null}
      {data.result ? (
        <Box flexDirection="column" marginLeft={1} marginTop={1}>
          <Text bold color={toolExitCodeStyle(data.exitCode).color}>{toolExitCodeStyle(data.exitCode).icon} {data.result.slice(0, 300)}</Text>
          {data.result.length > 300 ? <Text {...t.colors.dim}>... ({data.result.length - 300} more)</Text> : null}
        </Box>
      ) : null}
      {data.time ? (
        <Box marginTop={0}>
          <Text {...t.colors.timing}>⏱ {data.time}{data.exitCode !== undefined ? ` · exit ${data.exitCode === 0 ? 'ok' : data.exitCode}` : ''}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function toolExitCodeStyle(exitCode?: number) {
  if (exitCode === undefined || exitCode === 0) return { color: 'green', icon: '✓' };
  return { color: 'red', icon: '✗' };
}
