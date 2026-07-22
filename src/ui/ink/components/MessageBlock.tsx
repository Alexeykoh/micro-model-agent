import { Box, Text } from 'ink';
import { getInkTheme } from '../theme.js';
import { LineNumbers, BracketTag } from './Tags.js';

export interface MessageItem {
  type: 'message' | 'info' | 'success' | 'warning' | 'error' | 'dim' | 'heading' | 'bracket' | 'plugins';
  content?: string;
  tag?: string;
  message?: string;
  role?: 'user' | 'assistant' | 'subagent' | 'expert';
}

const TYPE_STYLES: Record<string, { prefix: string; colorKey: string; icon: string }> = {
  info:    { prefix: '  ', colorKey: 'info',    icon: 'ℹ' },
  success: { prefix: '  ', colorKey: 'success', icon: '✓' },
  warning: { prefix: '  ', colorKey: 'warning', icon: '⚠' },
  error:   { prefix: '  ', colorKey: 'error',   icon: '✗' },
  dim:     { prefix: '  ', colorKey: 'dim',     icon: '' },
  heading: { prefix: '  ', colorKey: 'heading',  icon: '' },
};

export function MessageBlock({ item }: { item: MessageItem }) {
  const t = getInkTheme();

  if (item.role === 'assistant') {
    return (
      <Box>
        <Text color="cyan">{'  │ '}</Text>
        <Box flexGrow={1} flexDirection="column">
          <Text>{item.content ?? ''}</Text>
        </Box>
      </Box>
    );
  }

  if (item.role === 'user') {
    return (
      <Box>
        <Text color="yellow">{'  │ '}</Text>
        <Box flexGrow={1}>
          <Text bold color="yellow">{item.content}</Text>
        </Box>
      </Box>
    );
  }

  if (item.role === 'subagent') {
    return (
      <Box>
        <Text color="magenta">{'  │ '}</Text>
        <Box flexGrow={1}>
          <Text color="magenta">{item.content ?? ''}</Text>
        </Box>
      </Box>
    );
  }

  if (item.role === 'expert') {
    return (
      <Box>
        <Text color="green">{'  │ '}</Text>
        <Box flexGrow={1}>
          <Text color="green">{item.content ?? ''}</Text>
        </Box>
      </Box>
    );
  }

  // ─── Простое сообщение ─────────────────────────────
  if (item.type === 'message') {
    return (
      <Box>
        <Text>{'  '}</Text>
        <Text>{item.content}</Text>
      </Box>
    );
  }

  // ─── Bracket tag ───────────────────────────────────
  if (item.type === 'bracket') {
    return <BracketTag tag={item.tag || ''} message={item.message || ''} />;
  }

  // ─── Plugins ───────────────────────────────────────
  if (item.type === 'plugins') {
    return (
      <Box>
        <Text dimColor>{`    plugins: ${item.content}`}</Text>
      </Box>
    );
  }

  // ─── Стилизованные типы (info, success, warning, error, dim, heading) ──
  const style = TYPE_STYLES[item.type];
  if (style) {
    const colorStyle = t.colors[style.colorKey];
    return (
      <Box>
        <Text>{style.prefix}</Text>
        {style.icon ? <Text {...colorStyle}>{style.icon} </Text> : null}
        <Text {...colorStyle}>{item.content}</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text>{'  '}</Text>
      <Text>{item.content}</Text>
    </Box>
  );
}

export function FileOutputBlock({ lines, startIndex }: { lines: string[]; startIndex: number }) {
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const lineNum = (startIndex + i).toString().padStart(4);
        return (
          <Box key={i}>
            <LineNumbers text={lineNum} /><Text>{' │ '}{line}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
