let tiktoken: any = null;

async function loadTiktoken(): Promise<void> {
  if (tiktoken) return;
  try {
    const mod = await import('js-tiktoken');
    tiktoken = mod;
  } catch {
    tiktoken = null;
  }
}

export async function countTokens(text: string): Promise<number> {
  await loadTiktoken();
  if (tiktoken?.encodingForModel) {
    try {
      const enc = tiktoken.encodingForModel('gpt-4');
      return enc.encode(text).length;
    } catch { /* fall through */ }
  }
  return Math.ceil(text.length / 4);
}
