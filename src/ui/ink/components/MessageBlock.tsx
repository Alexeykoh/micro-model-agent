import { Box, Text } from 'ink';
import Markdown from 'ink-markdown-es';
import { getInkTheme } from '../theme.js';
import { LineNumbers, BracketTag, DimText } from './Tags.js';

/**
 * Компонент отображения сообщений.
 *
 * Поддерживает:
 * - Markdown с подсветкой синтаксиса
 * - Сообщения разных типов (info, success, warning, error)
 * - Номера строк
 * - Bracket tags (inline-теги)
 *
 * @module ui/ink/components/MessageBlock
 */

/** Элемент сообщения */
export interface MessageItem {
  type: 'message' | 'info' | 'success' | 'warning' | 'error' | 'dim' | 'heading' | 'bracket';
  content?: string;
  tag?: string;
  message?: string;
  role?: 'user' | 'assistant';
}

const TYPE_COLORS: Record<string, keyof ReturnType<typeof getInkTheme>['colors']> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'error',
  dim: 'dim',
  heading: 'heading',
};

export function MessageBlock({ item }: { item: MessageItem }) {
  const t = getInkTheme();

  if (item.role === 'assistant') {
    return (
      <Box>
        <Text>{'  '}</Text>
        <Box flexGrow={1} flexDirection="column">
          <Box>
            <Text bold color="cyan">{'◆ '}</Text>
            <Markdown
              styles={{
                paragraph: { margin: 0 },
                listItem: { paddingLeft: 2, margin: 0 },
                code: { marginTop: 0, marginBottom: 0 },
                h1: { marginBottom: 0 },
                h2: { marginBottom: 0 },
                h3: { marginBottom: 0 },
              }}
            >
              {item.content ?? ''}
            </Markdown>
          </Box>
        </Box>
      </Box>
    );
  }

  if (item.role === 'user') {
    return (
      <Box>
        <Text>{'  '}</Text>
        <Text bold color="yellow">{'▶'}</Text>
        <Text>{' '}</Text>
        <Text bold>{item.content}</Text>
      </Box>
    );
  }

  if (item.type === 'message') {
    return (
      <Box>
        <Text>{item.content}</Text>
      </Box>
    );
  }

  if (item.type === 'bracket') {
    return <BracketTag tag={item.tag || ''} message={item.message || ''} />;
  }

  const colorKey = TYPE_COLORS[item.type];
  const style = colorKey ? t.colors[colorKey] : {};
  return (
    <Box>
      <Text {...style}>{item.content}</Text>
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
            <LineNumbers text={lineNum} /><Text>| {line}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
