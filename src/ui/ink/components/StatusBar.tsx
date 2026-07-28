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

  const modelShort = info.model ? (info.model.split('/').pop() || info.model) : null;
  const stepInfo = info.step !== undefined && info.maxSteps !== undefined
    ? `${info.step}/${info.maxSteps}`
    : null;

  return (
    <Box width="100%" paddingX={0}>
      <Box flexGrow={1}>
        <Text {...t.colors.dim}>{'─'.repeat(60)}</Text>
      </Box>
      <Box>
        {modelShort ? (
          <>
            <Text bold color="magenta">{modelShort}</Text>
            {stepInfo ? <Text {...t.colors.dim}>{' │ '}{stepInfo}</Text> : null}
            {usage ? <Text {...t.colors.dim}>{' │ '}{usage}</Text> : null}
          </>
        ) : (
          <Text bold color="magenta">MMA</Text>
        )}
      </Box>
    </Box>
  );
}
