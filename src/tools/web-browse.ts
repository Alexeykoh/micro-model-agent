import { t } from '../i18n/index'
import type { ToolDefinition } from './types'
import { isUrlAllowed, sanitizeUrl } from '../modules/security/network-validator'
import { logNetworkRequest, logSecurityBlock } from '../modules/security/audit-log'

export const webBrowseTool: ToolDefinition = {
  name: 'web_browse',
  description: 'Fetch and read a web page. Returns the page content as plain text.',
  tags: ['research'],
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
    },
    required: ['url'],
  },
  handler: async (ctx, args) => {
    const url = String(args.url || '')
    
    // Security check: validate URL
    const securityConfig = ctx.config.security?.network
    const validation = isUrlAllowed(url, securityConfig)
    
    if (!validation.allowed) {
      logSecurityBlock(
        ctx.sessionId,
        "network_request",
        validation.reason || "URL blocked by security policy",
        sanitizeUrl(url),
      );
      return {
        success: false,
        output: `[SECURITY BLOCKED] URL is not allowed: ${validation.reason}`,
      }
    }
    
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(securityConfig?.requestTimeout || 15000) })
      const text = await response.text()
      const stripped = text
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&[^;]+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      
      // Log successful network request
      logNetworkRequest(ctx.sessionId, sanitizeUrl(url), true, `Status: ${response.status}`);
      
      const maxLen = securityConfig?.maxResponseSize || 8000
      const content = stripped.length > maxLen ? stripped.slice(0, maxLen) + t('file.truncated') : stripped
      return { success: true, output: content || t('file.empty_page') }
    } catch (err: any) {
      logNetworkRequest(ctx.sessionId, sanitizeUrl(url), false, `Error: ${err.message}`);
      return { success: false, output: t('error.fetch_url_failed', { url: sanitizeUrl(url), message: err.message }) }
    }
  },
}
