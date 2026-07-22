import { describe, it, expect } from 'vitest';
import { webBrowseDefinition, webBrowseHandler } from '../src/tools/web-browse.js';

// ─── Tool Definition ─────────────────────────────────────

describe('web_browse definition', () => {
  it('has correct name', () => {
    expect(webBrowseDefinition.function.name).toBe('web_browse');
  });

  it('has all required actions in enum', () => {
    const actions = (webBrowseDefinition.function.parameters as any).properties.action.enum;
    expect(actions).toContain('navigate');
    expect(actions).toContain('click');
    expect(actions).toContain('type');
    expect(actions).toContain('extract');
    expect(actions).toContain('screenshot');
    expect(actions).toContain('scroll');
    expect(actions).toContain('wait');
    expect(actions).toContain('get_links');
    expect(actions).toContain('evaluate');
    expect(actions).toContain('close');
  });

  it('action is required', () => {
    const required = (webBrowseDefinition.function.parameters as any).required;
    expect(required).toContain('action');
  });
});

// ─── Handler Validation ──────────────────────────────────

describe('web_browse handler', () => {
  it('returns error when action is empty', async () => {
    const result = await webBrowseHandler.execute({}, { cwd: '/tmp' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('action is required');
  });

  it('returns error for navigate without url', async () => {
    const result = await webBrowseHandler.execute({ action: 'navigate' }, { cwd: '/tmp' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('url is required');
  });

  it('returns error for navigate with invalid url', async () => {
    const result = await webBrowseHandler.execute({ action: 'navigate', url: 'ftp://example.com' }, { cwd: '/tmp' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('URL must start with');
  });

  it('returns "no active page" for actions without prior navigate', async () => {
    // click, type, extract, etc. require an active page
    const actions = ['click', 'type', 'extract', 'screenshot', 'scroll', 'wait', 'get_links', 'evaluate', 'unknown'];
    for (const action of actions) {
      const result = await webBrowseHandler.execute({ action, selector: '#test' }, { cwd: '/tmp' });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No active page');
    }
  });

  it('close action works without active browser', async () => {
    const result = await webBrowseHandler.execute({ action: 'close' }, { cwd: '/tmp' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Browser closed');
  });

  it('handler has correct name', () => {
    expect(webBrowseHandler.name).toBe('web_browse');
  });

  it('handler definition matches exported definition', () => {
    expect(webBrowseHandler.definition).toBe(webBrowseDefinition);
  });
});
