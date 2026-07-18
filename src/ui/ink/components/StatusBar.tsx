import { Box, Text } from 'ink';
import { getInkTheme } from '../theme.js';

interface StatusInfo {
  provider?: string;
  model?: string;
  tokens?: number;
  contextWindow?: number;
  step?: number;
  maxSteps?: number;
}

export function StatusBar({ info, usage }: { info: StatusInfo; usage?: string }) {
  const t = getInkTheme();
  const parts: string[] = [];
  if (info.provider && info.model) {
    parts.push(`${info.provider}/${info.model}`);
  }
  if (info.tokens !== undefined && info.contextWindow !== undefined) {
    parts.push(`${info.tokens}/${info.contextWindow}`);
  }
  if (info.step !== undefined && info.maxSteps !== undefined) {
    parts.push(`step ${info.step}/${info.maxSteps}`);
  }
  if (usage) {
    parts.push(usage);
  }

  const display = parts.join(' │ ') || 'MMA — ready';

  return (
    <Box borderStyle="single" borderColor="gray" width="100%" paddingX={1}>
      <Text {...t.colors.dim}>{display}</Text>
    </Box>
  );
}
