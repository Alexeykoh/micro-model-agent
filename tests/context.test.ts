import { describe, it, expect } from 'vitest';
import { ContextManager } from '../src/agent/context.js';

describe('ContextManager', () => {
  it('tracks token usage', () => {
    const ctx = new ContextManager(32768);
    expect(ctx.totalTokens).toBe(0);
    expect(ctx.usagePercent).toBe(0);
  });

  it('detects compact threshold', () => {
    const ctx = new ContextManager(100, 0.85);
    expect(ctx.needsCompact).toBe(false);
  });

  it('formats usage string', () => {
    const ctx = new ContextManager(32768);
    const usage = ctx.formatUsage();
    expect(usage).toContain('Context:');
    expect(usage).toContain('compacted:');
  });
});
