import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleWebSearch, webSearchDefinition } from '../src/tools/web-search.js';
import { handleWebFetch, webFetchDefinition } from '../src/tools/web-fetch.js';
import { ToolRegistry } from '../src/tools/registry.js';

let originalFetch: typeof globalThis.fetch;
let mockFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mockFetch = ((...args: any[]) => Promise.resolve({ ok: true, status: 200, text: async () => '', headers: { get: () => 'text/plain' } })) as any;
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockResponse(opts: { ok?: boolean; status?: number; statusText?: string; text?: string; contentType?: string }) {
  mockFetch = (async () => ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? 'OK',
    text: async () => opts.text ?? '',
    headers: { get: () => opts.contentType ?? 'text/html' },
  })) as any;
  globalThis.fetch = mockFetch;
}

function mockError(msg: string) {
  mockFetch = (async () => { throw new Error(msg); }) as any;
  globalThis.fetch = mockFetch;
}

describe('web_search', () => {
  it('definition has correct name and required args', () => {
    expect(webSearchDefinition.function.name).toBe('web_search');
    expect(webSearchDefinition.function.parameters.required).toContain('query');
  });

  it('returns error on empty query', async () => {
    const r = await handleWebSearch({ query: '' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('query is required');
  });

  it('returns error on missing query', async () => {
    const r = await handleWebSearch({});
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('query is required');
  });

  it('returns search results on valid query', async () => {
    const html = `
      <html><body>
        <a href="https://example.com" class="result-link">Example Title</a>
        <td class="result-snippet">This is a snippet</td>
      </body></html>
    `;
    mockResponse({ text: html });

    const r = await handleWebSearch({ query: 'test query', maxResults: 3 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Example Title');
    expect(r.stdout).toContain('https://example.com');
    expect(r.stdout).toContain('This is a snippet');
  });

  it('parses single-quote HTML attributes (DuckDuckGo lite)', async () => {
    const html = `
      <html><body>
        <a href="https://example.com" class='result-link'>DDG Result</a>
        <td class='result-snippet'>DDG snippet</td>
      </body></html>
    `;
    mockResponse({ text: html });

    const r = await handleWebSearch({ query: 'test query', maxResults: 3 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('DDG Result');
    expect(r.stdout).toContain('https://example.com');
    expect(r.stdout).toContain('DDG snippet');
  });

  it('returns "No results found" when no results', async () => {
    mockResponse({ text: '<html><body></body></html>' });

    const r = await handleWebSearch({ query: 'nonexistentxyz' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('No results found.');
  });

  it('returns error on fetch failure', async () => {
    mockError('Network error');

    const r = await handleWebSearch({ query: 'test' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Search error');
  });

  it('returns error on HTTP failure', async () => {
    mockResponse({ ok: false, status: 503 });

    const r = await handleWebSearch({ query: 'test' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Search failed');
  });

  it('is registered in ToolRegistry', () => {
    const registry = new ToolRegistry();
    const defs = registry.getDefinitions();
    const names = defs.map(d => d.function.name);
    expect(names).toContain('web_search');
  });
});

describe('web_fetch', () => {
  it('definition has correct name and required args', () => {
    expect(webFetchDefinition.function.name).toBe('web_fetch');
    expect(webFetchDefinition.function.parameters.required).toContain('url');
  });

  it('returns error on empty url', async () => {
    const r = await handleWebFetch({ url: '' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('url is required');
  });

  it('returns error on missing url', async () => {
    const r = await handleWebFetch({});
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('url is required');
  });

  it('returns error on invalid protocol', async () => {
    const r = await handleWebFetch({ url: 'ftp://example.com' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('URL must start with http:// or https://');
  });

  it('returns content on valid URL', async () => {
    mockResponse({ text: '<html><body>Hello World</body></html>', contentType: 'text/html' });

    const r = await handleWebFetch({ url: 'https://example.com' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Hello World');
  });

  it('returns error on fetch failure', async () => {
    mockError('DNS resolution failed');

    const r = await handleWebFetch({ url: 'https://nonexistent.invalid' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Fetch error');
  });

  it('returns error on HTTP failure', async () => {
    mockResponse({ ok: false, status: 404, statusText: 'Not Found' });

    const r = await handleWebFetch({ url: 'https://example.com/missing' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('404');
  });

  it('is registered in ToolRegistry', () => {
    const registry = new ToolRegistry();
    const defs = registry.getDefinitions();
    const names = defs.map(d => d.function.name);
    expect(names).toContain('web_fetch');
  });
});

describe('ToolRegistry web tools dispatch', () => {
  it('dispatches web_search through registry.execute', async () => {
    const html = `
      <html><body>
        <a href="https://example.com" class="result-link">Test Result</a>
        <td class="result-snippet">A snippet</td>
      </body></html>
    `;
    mockResponse({ text: html });

    const registry = new ToolRegistry();
    const result = await registry.execute({
      id: 'test-1',
      name: 'web_search',
      arguments: { query: 'test', maxResults: 1 },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Test Result');
  });

  it('dispatches web_fetch through registry.execute', async () => {
    mockResponse({ text: 'Plain text content', contentType: 'text/plain' });

    const registry = new ToolRegistry();
    const result = await registry.execute({
      id: 'test-2',
      name: 'web_fetch',
      arguments: { url: 'https://example.com' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Plain text content');
  });
});
