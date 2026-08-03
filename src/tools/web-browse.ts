import { t } from '../i18n/index'
import type { ToolDefinition } from './types'
import { isUrlAllowed, sanitizeUrl } from '../modules/security/network-validator'
import { logNetworkRequest, logSecurityBlock } from '../modules/security/audit-log'
import { getSessionSecurityConfig } from '../modules/security/session-isolation'
import { MAX_PREVIEW_LINES } from './preview'

const MAX_CHARS = 3000

export const webBrowseTool: ToolDefinition = {
  name: 'web_browse',
  description: `Fetch and read a web page. Returns the page content as plain text (max ${MAX_PREVIEW_LINES} lines / ${MAX_CHARS} chars).`,
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
    
    // Get session-specific security config
    const securityConfig = ctx.sessionContext 
      ? getSessionSecurityConfig(ctx.config, ctx.sessionContext).network
      : ctx.config.security?.network
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
      
      const maxLen = securityConfig?.maxResponseSize || MAX_CHARS
      let content = stripped.length > maxLen ? stripped.slice(0, maxLen) + t('file.truncated') : stripped
      const lines = content.split('\n')
      if (lines.length > MAX_PREVIEW_LINES) {
        content = lines.slice(0, MAX_PREVIEW_LINES).join('\n') + `\n... (${lines.length - MAX_PREVIEW_LINES} more lines)`
      }
      return { success: true, output: content || t('file.empty_page') }
    } catch (err: any) {
      logNetworkRequest(ctx.sessionId, sanitizeUrl(url), false, `Error: ${err.message}`);
      return { success: false, output: t('error.fetch_url_failed', { url: sanitizeUrl(url), message: err.message }) }
    }
  },
}
