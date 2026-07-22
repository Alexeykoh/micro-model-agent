import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { MessageBlock, type MessageItem } from '../src/ui/ink/components/MessageBlock.js';
import { ToolCallBlock, type ToolCallData } from '../src/ui/ink/components/ToolCallBlock.js';
import { StreamBlock, SpinnerLine } from '../src/ui/ink/components/StreamBlock.js';
import { StatusBar } from '../src/ui/ink/components/StatusBar.js';
import { BracketTag, InfoTag, SuccessTag, WarningTag, ErrorTag, TurnSeparator } from '../src/ui/ink/components/Tags.js';
import { Conversation, type ConversationEntry } from '../src/ui/ink/components/Conversation.js';

// ─── MessageBlock ──────────────────────────────────────

describe('MessageBlock', () => {
  it('renders assistant message with cyan accent', () => {
    const item: MessageItem = { type: 'message', content: 'Hello world', role: 'assistant' };
    const { lastFrame } = render(<MessageBlock item={item} />);
    expect(lastFrame()).toContain('Hello world');
    expect(lastFrame()).toContain('│');
  });

  it('renders user message with yellow accent', () => {
    const item: MessageItem = { type: 'message', content: 'User question', role: 'user' };
    const { lastFrame } = render(<MessageBlock item={item} />);
    expect(lastFrame()).toContain('User question');
    expect(lastFrame()).toContain('│');
  });

  it('renders plain message without role', () => {
    const item: MessageItem = { type: 'message', content: 'Plain text' };
    const { lastFrame } = render(<MessageBlock item={item} />);
    expect(lastFrame()).toContain('Plain text');
  });

  it('renders info type with icon', () => {
    const item: MessageItem = { type: 'info', content: 'Info message' };
    const { lastFrame } = render(<MessageBlock item={item} />);
    expect(lastFrame()).toContain('ℹ');
    expect(lastFrame()).toContain('Info message');
  });

  it('renders success type with icon', () => {
    const item: MessageItem = { type: 'success', content: 'Done!' };
    const { lastFrame } = render(<MessageBlock item={item} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('Done!');
  });

  it('renders warning type with icon', () => {
    const item: MessageItem = { type: 'warning', content: 'Be careful' };
    const { lastFrame } = render(<MessageBlock item={item} />);
    expect(lastFrame()).toContain('⚠');
    expect(lastFrame()).toContain('Be careful');
  });

  it('renders error type with icon', () => {
    const item: MessageItem = { type: 'error', content: 'Something broke' };
    const { lastFrame } = render(<MessageBlock item={item} />);
    expect(lastFrame()).toContain('✗');
    expect(lastFrame()).toContain('Something broke');
  });

  it('renders bracket tag', () => {
    const item: MessageItem = { type: 'bracket', tag: 'user', message: 'test message' };
    const { lastFrame } = render(<MessageBlock item={item} />);
    expect(lastFrame()).toContain('[user]');
    expect(lastFrame()).toContain('test message');
  });

  it('renders plugins line', () => {
    const item: MessageItem = { type: 'plugins', content: 'lint-on-write' };
    const { lastFrame } = render(<MessageBlock item={item} />);
    expect(lastFrame()).toContain('plugins: lint-on-write');
  });

  it('renders empty assistant message', () => {
    const item: MessageItem = { type: 'message', content: '', role: 'assistant' };
    const { lastFrame } = render(<MessageBlock item={item} />);
    expect(lastFrame()).toContain('│');
  });
});

// ─── ToolCallBlock ─────────────────────────────────────

describe('ToolCallBlock', () => {
  it('renders tool name', () => {
    const data: ToolCallData = { name: 'read_file', args: '{"path":"test.ts"}', result: '', time: '' };
    const { lastFrame } = render(<ToolCallBlock data={data} />);
    expect(lastFrame()).toContain('read_file');
  });

  it('renders args preview truncated at 120 chars', () => {
    const longArgs = 'x'.repeat(200);
    const data: ToolCallData = { name: 'bash', args: longArgs, result: '', time: '' };
    const { lastFrame } = render(<ToolCallBlock data={data} />);
    expect(lastFrame()).toContain('…');
  });

  it('renders result with success icon', () => {
    const data: ToolCallData = { name: 'write_file', args: '', result: 'OK', time: '0.1s', exitCode: 0 };
    const { lastFrame } = render(<ToolCallBlock data={data} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('OK');
  });

  it('renders result with error icon on non-zero exit', () => {
    const data: ToolCallData = { name: 'bash', args: '', result: 'Error', time: '0.2s', exitCode: 1 };
    const { lastFrame } = render(<ToolCallBlock data={data} />);
    expect(lastFrame()).toContain('✗');
    expect(lastFrame()).toContain('exit 1');
  });

  it('renders timing info', () => {
    const data: ToolCallData = { name: 'grep_search', args: '', result: '', time: '1.5s' };
    const { lastFrame } = render(<ToolCallBlock data={data} />);
    expect(lastFrame()).toContain('1.5s');
  });

  it('renders subagent tool with special styling', () => {
    const data: ToolCallData = { name: 'subagent', args: '{"task":"test"}', result: '', time: '2s' };
    const { lastFrame } = render(<ToolCallBlock data={data} />);
    expect(lastFrame()).toContain('subagent');
  });

  it('renders subagent buffer with nested tool calls', () => {
    const data: ToolCallData = {
      name: 'subagent',
      args: '',
      result: '',
      time: '3s',
      subagentBuffer: {
        lines: ['line1', 'line2'],
        toolCalls: [{ name: 'read_file', args: '{}', result: 'content' }],
      },
    };
    const { lastFrame } = render(<ToolCallBlock data={data} />);
    expect(lastFrame()).toContain('read_file');
    expect(lastFrame()).toContain('content');
    expect(lastFrame()).toContain('line1');
  });

  it('truncates long results at 300 chars', () => {
    const longResult = 'a'.repeat(500);
    const data: ToolCallData = { name: 'bash', args: '', result: longResult, time: '0.1s', exitCode: 0 };
    const { lastFrame } = render(<ToolCallBlock data={data} />);
    expect(lastFrame()).toContain('200 more');
  });
});

// ─── StreamBlock ───────────────────────────────────────

describe('StreamBlock', () => {
  it('renders streaming content with > prefix', () => {
    const { lastFrame } = render(<StreamBlock content="Hello" isReasoning={false} />);
    expect(lastFrame()).toContain('>');
    expect(lastFrame()).toContain('Hello');
  });

  it('renders reasoning content', () => {
    const { lastFrame } = render(<StreamBlock content="thinking..." isReasoning={true} />);
    expect(lastFrame()).toContain('thinking...');
  });
});

describe('SpinnerLine', () => {
  it('renders default spinner text', () => {
    const { lastFrame } = render(<SpinnerLine />);
    expect(lastFrame()).toContain('thinking…');
  });

  it('renders custom spinner text', () => {
    const { lastFrame } = render(<SpinnerLine text="loading" />);
    expect(lastFrame()).toContain('loading');
  });
});

// ─── StatusBar ─────────────────────────────────────────

describe('StatusBar', () => {
  it('renders model name', () => {
    const { lastFrame } = render(<StatusBar info={{ model: 'qwen/qwen3.5-9b' }} />);
    expect(lastFrame()).toContain('qwen3.5-9b');
  });

  it('renders step info alongside model', () => {
    const { lastFrame } = render(<StatusBar info={{ model: 'qwen/qwen3.5-9b', step: 3, maxSteps: 10 }} />);
    expect(lastFrame()).toContain('3/10');
  });

  it('renders context usage alongside model', () => {
    const { lastFrame } = render(<StatusBar info={{ model: 'qwen/qwen3.5-9b' }} usage="50%" />);
    expect(lastFrame()).toContain('50%');
  });

  it('renders MMA when no model', () => {
    const { lastFrame } = render(<StatusBar info={{}} />);
    expect(lastFrame()).toContain('MMA');
  });

  it('does not show step info without model', () => {
    const { lastFrame } = render(<StatusBar info={{ step: 3, maxSteps: 10 }} />);
    // Step info is only shown when model is present
    expect(lastFrame()).toContain('MMA');
  });

  it('renders separator line', () => {
    const { lastFrame } = render(<StatusBar info={{}} />);
    expect(lastFrame()).toContain('─');
  });
});

// ─── Tags ──────────────────────────────────────────────

describe('Tags', () => {
  it('InfoTag renders with ℹ icon', () => {
    const { lastFrame } = render(<InfoTag>info text</InfoTag>);
    expect(lastFrame()).toContain('ℹ');
    expect(lastFrame()).toContain('info text');
  });

  it('SuccessTag renders with ✓ icon', () => {
    const { lastFrame } = render(<SuccessTag>success text</SuccessTag>);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('success text');
  });

  it('WarningTag renders with ⚠ icon', () => {
    const { lastFrame } = render(<WarningTag>warning text</WarningTag>);
    expect(lastFrame()).toContain('⚠');
    expect(lastFrame()).toContain('warning text');
  });

  it('ErrorTag renders with ✗ icon', () => {
    const { lastFrame } = render(<ErrorTag>error text</ErrorTag>);
    expect(lastFrame()).toContain('✗');
    expect(lastFrame()).toContain('error text');
  });

  it('BracketTag user has yellow color', () => {
    const { lastFrame } = render(<BracketTag tag="user" message="test" />);
    expect(lastFrame()).toContain('[user]');
    expect(lastFrame()).toContain('test');
  });

  it('BracketTag non-user has info color', () => {
    const { lastFrame } = render(<BracketTag tag="system" message="test" />);
    expect(lastFrame()).toContain('[system]');
  });

  it('TurnSeparator renders line', () => {
    const { lastFrame } = render(<TurnSeparator />);
    expect(lastFrame()).toContain('─');
  });
});

// ─── Conversation ──────────────────────────────────────

describe('Conversation', () => {
  it('renders messages', () => {
    const entries: ConversationEntry[] = [
      { id: 1, kind: 'message', data: { type: 'message', content: 'Hello', role: 'user' } },
      { id: 2, kind: 'message', data: { type: 'message', content: 'Hi there', role: 'assistant' } },
    ];
    const { lastFrame } = render(
      <Conversation entries={entries} streaming={false} streamingContent="" isReasoning={false} showSpinner={false} />
    );
    expect(lastFrame()).toContain('Hello');
    expect(lastFrame()).toContain('Hi there');
  });

  it('renders tool calls', () => {
    const entries: ConversationEntry[] = [
      { id: 1, kind: 'tool_call', data: { name: 'bash', args: 'ls', result: 'file.ts', time: '0.1s' } },
    ];
    const { lastFrame } = render(
      <Conversation entries={entries} streaming={false} streamingContent="" isReasoning={false} showSpinner={false} />
    );
    expect(lastFrame()).toContain('bash');
  });

  it('renders streaming content', () => {
    const { lastFrame } = render(
      <Conversation entries={[]} streaming={true} streamingContent="typing..." isReasoning={false} showSpinner={false} />
    );
    expect(lastFrame()).toContain('typing...');
  });

  it('renders spinner when not streaming', () => {
    const { lastFrame } = render(
      <Conversation entries={[]} streaming={false} streamingContent="" isReasoning={false} showSpinner={true} />
    );
    expect(lastFrame()).toContain('thinking');
  });

  it('does not render spinner when streaming', () => {
    const { lastFrame } = render(
      <Conversation entries={[]} streaming={true} streamingContent="text" isReasoning={false} showSpinner={true} />
    );
    // Spinner should not appear when streaming
    expect(lastFrame()).not.toContain('thinking');
  });
});
