import type { ToolDefinition } from './registry.js';
import { logInfo } from '../logger.js';

/**
 * Загрузка содержимого URL.
 *
 * Получает содержимое веб-страницы и возвращает его как текст.
 * Автоматически удаляет HTML-теги. Ограничение: 100KB.
 *
 * @module tools/web-fetch
 */

export const webFetchDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'web_fetch',
    description: 'Fetch a URL and return its contents as text. Strips HTML tags. Max 100KB.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch (http/https)' },
      },
      required: ['url'],
    },
  },
};

export async function handleWebFetch(
  args: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }> {
  const url = String(args.url ?? '').trim();
  if (!url) {
    return { stdout: '', stderr: 'url is required', exitCode: 1, truncated: false };
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { stdout: '', stderr: 'URL must start with http:// or https://', exitCode: 1, truncated: false };
  }

  try {
    logInfo('WEB', `Fetching: ${url}`);
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MMA/1.0)',
        'Accept': 'text/html,text/plain,*/*',
      },
    });

    if (!res.ok) {
      return { stdout: '', stderr: `HTTP ${res.status}: ${res.statusText}`, exitCode: 1, truncated: false };
    }

    const contentType = res.headers.get('content-type') || '';
    const isText = contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('xml');
    if (!isText) {
      return { stdout: '', stderr: `Unsupported content type: ${contentType}`, exitCode: 1, truncated: false };
    }

    let text = await res.text();

    if (contentType.includes('html')) {
      text = stripHtml(text);
    }

    const maxLen = 100_000;
    let truncated = false;
    if (text.length > maxLen) {
      text = text.slice(0, maxLen) + `\n... (truncated, ${text.length} total chars)`;
      truncated = true;
    }

    return { stdout: text, stderr: '', exitCode: 0, truncated };
  } catch (e: any) {
    return { stdout: '', stderr: `Fetch error: ${e.message}`, exitCode: 1, truncated: false };
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .replace(/^\s+|\s+$/gm, '')
    .trim();
}
