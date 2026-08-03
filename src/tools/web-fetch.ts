import { t } from '../i18n/index'
import type { ToolDefinition } from './types'
import { isUrlAllowed, sanitizeUrl } from '../modules/security/network-validator'
import { logNetworkRequest, logSecurityBlock } from '../modules/security/audit-log'
import { getSessionSecurityConfig } from '../modules/security/session-isolation'
import { DEFAULT_SECURITY_CONFIG } from '../config/security'
import { MAX_PREVIEW_LINES } from './preview'

const MAX_CHARS = 5000

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&[^;]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description: 'Fetch a URL and convert its content to markdown. Use for reading documentation, APIs, web pages.',
  tags: ['research'],
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
    },
    required: ['url'],
  },
  handler: async (ctx, args) => {
    const url = String(args.url)
    
    // Get session-specific security config
    const config = ctx.config || {}
    const securityConfig = ctx.sessionContext 
      ? getSessionSecurityConfig(config, ctx.sessionContext).network
      : config.security?.network || DEFAULT_SECURITY_CONFIG.network
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
      if (!response.ok) {
        return { success: false, output: t('error.http', { status: response.status, statusText: response.statusText }) }
      }
      const contentType = response.headers.get('content-type') || ''
      const text = await response.text()
      const cleaned = contentType.includes('html') ? stripHtml(text) : text
      
      // Log successful network request
      logNetworkRequest(ctx.sessionId, sanitizeUrl(url), true, `Status: ${response.status}`);
      
      if (cleaned.length > (securityConfig?.maxResponseSize || MAX_CHARS)) {
        let content = cleaned.slice(0, securityConfig?.maxResponseSize || MAX_CHARS) + t('file.truncated')
        const lines = content.split('\n')
        if (lines.length > MAX_PREVIEW_LINES) {
          content = lines.slice(0, MAX_PREVIEW_LINES).join('\n') + `\n... (${lines.length - MAX_PREVIEW_LINES} more lines)`
        }
        return { success: true, output: content }
      }
      const lines = cleaned.split('\n')
      if (lines.length > MAX_PREVIEW_LINES) {
        return { success: true, output: lines.slice(0, MAX_PREVIEW_LINES).join('\n') + `\n... (${lines.length - MAX_PREVIEW_LINES} more lines)` }
      }
      return { success: true, output: cleaned || t('file.empty_page') }
    } catch (e: any) {
      logNetworkRequest(ctx.sessionId, sanitizeUrl(url), false, `Error: ${e.message}`);
      return { success: false, output: t('error.fetch_failed', { message: e.message }) }
    }
  },
}
