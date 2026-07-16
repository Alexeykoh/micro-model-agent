import { describe, it, expect } from 'vitest';
import { sanitize } from '../src/tools/sanitizer.js';

describe('sanitize', () => {
  it('allows read-only commands', () => {
    expect(sanitize('ls -la').safe).toBe(true);
    expect(sanitize('cat file.txt').safe).toBe(true);
    expect(sanitize('git status').safe).toBe(true);
  });

  it('blocks dangerous commands', () => {
    expect(sanitize('rm -rf /').safe).toBe(false);
    expect(sanitize('chmod 777 file').safe).toBe(false);
  });

  it('detects read-only commands', () => {
    expect(sanitize('ls').readOnly).toBe(true);
    expect(sanitize('cat file').readOnly).toBe(true);
    expect(sanitize('rm file').readOnly).toBe(false);
  });

  it('strips wrappers before checking', () => {
    expect(sanitize('timeout 10 rm -rf /').safe).toBe(false);
    expect(sanitize('time ls').safe).toBe(true);
  });
});
