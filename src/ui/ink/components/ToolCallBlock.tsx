import { Box, Text } from 'ink';
import { getInkTheme } from '../theme.js';

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

  const accentColor = isSub ? 'yellow' : t.colors.toolName.color;
  const prefix = isSub ? '⊞ ' : '';

  return (
    <Box flexDirection="column" marginLeft={1}>
      {/* Заголовок инструмента */}
      <Box>
        <Text color={accentColor}>{'│ '}</Text>
        <Text bold color={accentColor}>{prefix}{isSub ? 'subagent' : data.name}</Text>
        {data.time ? (
          <Text {...t.colors.dim}>{'  '}{data.time}</Text>
        ) : null}
      </Box>

      {/* Аргументы */}
      {data.args ? (
        <Box marginLeft={2}>
          <Text {...t.colors.dim}>{formatArgs(data.name, data.args)}</Text>
        </Box>
      ) : null}

      {/* Буфер субагента */}
      {data.subagentBuffer ? (
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          {data.subagentBuffer.toolCalls.map((tc, i) => (
            <Box key={i} flexDirection="column">
              <Text {...t.colors.dim}>{'↳ '}{tc.name}</Text>
              {tc.result ? (
                <Text color="green">  {tc.result.slice(0, 150)}{tc.result.length > 150 ? '…' : ''}</Text>
              ) : null}
            </Box>
          ))}
          {data.subagentBuffer.lines.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              {data.subagentBuffer.lines.slice(-15).map((line, i) => (
                <Text key={i} {...t.colors.dim}>{'  '}{line.slice(0, 120)}{line.length > 120 ? '…' : ''}</Text>
              ))}
            </Box>
          ) : null}
        </Box>
      ) : null}

      {/* Результат */}
      {data.result ? (
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          <Text color={exitColor(data.exitCode)}>
            {exitIcon(data.exitCode)}{' '}{data.result.slice(0, 300)}
          </Text>
          {data.result.length > 300 ? (
            <Text {...t.colors.dim}>{'  '}… ({data.result.length - 300} more)</Text>
          ) : null}
        </Box>
      ) : null}

      {/* Exit code (только при ошибке) */}
      {data.exitCode !== undefined && data.exitCode !== 0 ? (
        <Box marginLeft={2}>
          <Text color="red">exit {data.exitCode}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function exitIcon(code?: number): string {
  return code === undefined || code === 0 ? '✓' : '✗';
}

function exitColor(code?: number): string {
  return code === undefined || code === 0 ? 'green' : 'red';
}

function formatArgs(toolName: string, argsJson: string): string {
  if (toolName === 'subagent') {
    try {
      const args = JSON.parse(argsJson);
      const task = args.task || '';
      const files = args.existingFiles || '';
      let result = task.length > 100 ? task.slice(0, 97) + '…' : task;
      if (files) result += ` ← ${files}`;
      return result;
    } catch { /* fall through */ }
  }
  return argsJson.length > 120 ? argsJson.slice(0, 117) + '…' : argsJson;
}
