/** BCP-2: ответ не должен пересказывать каноничную подсказку блокировки своими словами. */

export interface BlockedResult {
  url: string;
  canonical: string;
}

interface ToolMessage {
  role: string;
  content?: unknown;
  blocked?: boolean;
}

const URL_RE = /URL not allowed:\s*(\S+)/i;
const ACTION_RE = /Action:\s*.+$/m;

function contentOf(m: ToolMessage): string {
  return typeof m.content === "string" ? m.content : "";
}

export function collectBlockedResults(messages: readonly ToolMessage[]): BlockedResult[] {
  const out: BlockedResult[] = [];
  for (const m of messages) {
    if (m.role !== "tool" || m.blocked !== true) continue;
    const text = contentOf(m);
    const url = text.match(URL_RE)?.[1];
    const canonical = text.match(ACTION_RE)?.[0];
    if (url && canonical) out.push({ url, canonical: canonical.trim() });
  }
  return out;
}

/** True, если ответ говорит об URL блокировки, но искажает каноничную подсказку. */
export function checkBlockedClaim(
  answer: string,
  blocked: readonly BlockedResult[],
): { reanswer: boolean; canonical?: string } {
  for (const item of blocked) {
    if (!answer.includes(item.url)) continue;
    if (!answer.includes(item.canonical)) return { reanswer: true, canonical: item.canonical };
  }
  return { reanswer: false };
}
