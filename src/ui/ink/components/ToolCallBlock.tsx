import { Box, Text } from 'ink';
import { getInkTheme } from '../theme.js';

export interface ToolCallData {
  name: string;
  args: string;
  result: string;
  time: string;
  exitCode?: number;
}

export function ToolCallBlock({ data }: { data: ToolCallData }) {
  const t = getInkTheme();
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" marginLeft={1} paddingX={1}>
      <Text>
        <Text {...t.colors.toolName}>tool: {data.name}</Text>
        <Text {...t.colors.dim}> ──</Text>
      </Text>
      {data.args ? <Text {...t.colors.dim}>{data.args}</Text> : null}
      {data.result ? (
        <Box flexDirection="column">
          <Text {...t.colors.dim}>Result:</Text>
          <Text>{data.result.slice(0, 500)}</Text>
          {data.result.length > 500 ? <Text {...t.colors.dim}>... ({data.result.length - 500} more)</Text> : null}
        </Box>
      ) : null}
      {data.time ? (
        <Text {...t.colors.timing}>⏱ {data.time}{data.exitCode !== undefined ? ` · exit ${data.exitCode}` : ''}</Text>
      ) : null}
    </Box>
  );
}
