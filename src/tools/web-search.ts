import type { ToolDefinition } from './registry.js';

/**
 * Веб-поиск через DuckDuckGo Lite.
 *
 * Возвращает результаты с заголовками, URL и сниппетами.
 * Используется для поиска информации в интернете.
 *
 * @module tools/web-search
 */

export const webSearchDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web using DuckDuckGo. Returns results with title, URL, and snippet.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        maxResults: { type: 'number', description: 'Max results (default 5, max 10)' },
      },
      required: ['query'],
    },
  },
};

export async function handleWebSearch(
  args: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }> {
  const query = String(args.query ?? '').trim();
  if (!query) {
    return { stdout: '', stderr: 'query is required', exitCode: 1, truncated: false };
  }

  const maxResults = Math.min(Math.max(Number(args.maxResults) || 5, 1), 10);

  try {
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MMA/1.0)' },
    });
    if (!res.ok) {
      return { stdout: '', stderr: `Search failed: HTTP ${res.status}`, exitCode: 1, truncated: false };
    }

    const html = await res.text();
    const results = parseDuckDuckGoResults(html, maxResults);

    if (results.length === 0) {
      return { stdout: 'No results found.', stderr: '', exitCode: 0, truncated: false };
    }

    let output = `Web search results for "${query}":\n\n`;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      output += `${i + 1}. ${r.title}\n`;
      output += `   URL: ${r.url}\n`;
      if (r.snippet) output += `   ${r.snippet}\n`;
      output += '\n';
    }

    return { stdout: output.trim(), stderr: '', exitCode: 0, truncated: false };
  } catch (e: any) {
    return { stdout: '', stderr: `Search error: ${e.message}`, exitCode: 1, truncated: false };
  }
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseDuckDuckGoResults(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];

  const linkRegex = /<a[^>]*href="([^"]*)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g;

  const links: { url: string; title: string }[] = [];
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    let url = match[1];
    const title = match[2].replace(/<[^>]+>/g, '').trim();
    if (url.startsWith('//')) url = 'https:' + url;
    if (!url.startsWith('http')) continue;
    if (title) links.push({ url, title });
    if (links.length >= max) break;
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(match[1].replace(/<[^>]+>/g, '').trim());
  }

  for (let i = 0; i < links.length; i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] || '',
    });
  }

  return results;
}
