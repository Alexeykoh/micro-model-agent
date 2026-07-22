import React from 'react';
import { Box } from 'ink';
import { MessageBlock, type MessageItem } from './MessageBlock.js';
import { ToolCallBlock, type ToolCallData } from './ToolCallBlock.js';
import { StreamBlock, SpinnerLine } from './StreamBlock.js';
import { TurnSeparator } from './Tags.js';

export type ConversationEntry =
  | { id: number; kind: 'message'; data: MessageItem }
  | { id: number; kind: 'tool_call'; data: ToolCallData };

function shouldShowSeparator(entries: ConversationEntry[], index: number): boolean {
  if (index === 0) return false;
  const prev = entries[index - 1];
  const curr = entries[index];
  // Разделитель между tool_call и message
  if (prev.kind === 'tool_call' && curr.kind === 'message') return true;
  // Разделитель между двумя message
  if (prev.kind === 'message' && curr.kind === 'message') return true;
  return false;
}

export function Conversation({
  entries,
  streaming,
  streamingContent,
  isReasoning,
  showSpinner,
}: {
  entries: ConversationEntry[];
  streaming: boolean;
  streamingContent: string;
  isReasoning: boolean;
  showSpinner: boolean;
}) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="column">
        {entries.map((entry: ConversationEntry, index: number) => {
          return (
            <React.Fragment key={entry.id}>
              {shouldShowSeparator(entries, index) ? <TurnSeparator /> : null}
              {entry.kind === 'message' ? (
                <MessageBlock item={entry.data as MessageItem} />
              ) : (
                <ToolCallBlock data={entry.data as ToolCallData} />
              )}
            </React.Fragment>
          );
        })}
      </Box>
      {showSpinner && !streaming && <SpinnerLine />}
      {streaming && <StreamBlock content={streamingContent} isReasoning={isReasoning} />}
    </Box>
  );
}
