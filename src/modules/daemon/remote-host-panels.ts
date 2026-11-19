/**
 * Панельные запросы `RemoteHost` (split W10, правило ≤300): файлы, git, память,
 * скиллы, setup/index/lsp/plugins/update, картинки, журнал защиты, субагенты,
 * поиск. Базовый класс держит транспорт (адрес, токен, локаль, `request`),
 * чтобы `remote-host.ts` оставался про контракт `Host`.
 */
import { getLocale } from "../../i18n/index";
import { safeText, type RemoteHostOptions } from "./remote-host-types";

/** Базовый HTTP-клиент панельных запросов. */
export abstract class RemotePanelClient {
  constructor(protected readonly opts: RemoteHostOptions) {}

  async listFiles(path: string): Promise<unknown> {
    const res = await this.request(
      `${this.base}/v1/host/files${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    );
    if (!res.ok) throw new Error(`daemon files failed: ${res.status} ${await safeText(res)}`);
    return res.json();
  }

  async gitSnapshot(): Promise<unknown> {
    const res = await this.request(`${this.base}/v1/host/git`);
    if (!res.ok) throw new Error(`daemon git failed: ${res.status} ${await safeText(res)}`);
    return res.json();
  }

  async gitChanges(): Promise<unknown> {
    const res = await this.request(`${this.base}/v1/host/git/changes`);
    if (!res.ok) throw new Error(`daemon git changes failed: ${res.status} ${await safeText(res)}`);
    return res.json();
  }

  async gitDiff(path: string, staged: boolean): Promise<unknown> {
    const query = `?path=${encodeURIComponent(path)}${staged ? "&staged=1" : ""}`;
    const res = await this.request(`${this.base}/v1/host/git/diff${query}`);
    if (!res.ok) throw new Error(`daemon git diff failed: ${res.status} ${await safeText(res)}`);
    return res.json();
  }

  async memory(): Promise<unknown> {
    const res = await this.request(`${this.base}/v1/host/memory`);
    if (!res.ok) throw new Error(`daemon memory failed: ${res.status} ${await safeText(res)}`);
    return res.json();
  }

  async skills(): Promise<unknown> {
    const res = await this.request(`${this.base}/v1/host/skills`);
    if (!res.ok) throw new Error(`daemon skills failed: ${res.status} ${await safeText(res)}`);
    return res.json();
  }

  async plugins(): Promise<unknown> {
    const res = await this.request(`${this.base}/v1/host/plugins`);
    if (!res.ok) throw new Error(`daemon plugins failed: ${res.status} ${await safeText(res)}`);
    return res.json();
  }

  async installUpdate(): Promise<unknown> {
    const res = await this.request(`${this.base}/v1/host/update`, { method: "POST" });
    if (!res.ok) throw new Error(`daemon update failed: ${res.status} ${await safeText(res)}`);
    return res.json();
  }

  /** Байты картинки сессии; `null` — нет файла/сессии (404 не ошибка). */
  async readImage(
    sessionId: string,
    name: string,
  ): Promise<{ bytes: Uint8Array; mime: string } | null> {
    const res = await this.request(
      `${this.base}/v1/host/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(name)}`,
    );
    if (!res.ok) return null;
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      mime: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  /** Системный промпт раннера сессии. */
  async sessionPrompt(sessionId: string): Promise<unknown> {
    const res = await this.request(
      `${this.base}/v1/host/sessions/${encodeURIComponent(sessionId)}/system-prompt`,
    );
    if (!res.ok) throw new Error(`daemon prompt failed: ${res.status} ${await safeText(res)}`);
    return res.json();
  }

  /** Журнал защиты сессии. */
  async sessionSecurity(sessionId: string, limit?: number): Promise<unknown> {
    const suffix = limit !== undefined ? `?limit=${limit}` : "";
    const res = await this.request(
      `${this.base}/v1/host/sessions/${encodeURIComponent(sessionId)}/security${suffix}`,
    );
    if (!res.ok) throw new Error(`daemon security failed: ${res.status} ${await safeText(res)}`);
    return res.json();
  }

  /** Снимки прогонов субагентов. */
  async subagentRuns(sessionId: string, toolCallId?: string): Promise<unknown> {
    const suffix = toolCallId ? `?toolCallId=${encodeURIComponent(toolCallId)}` : "";
    const res = await this.request(
      `${this.base}/v1/host/sessions/${encodeURIComponent(sessionId)}/subagents${suffix}`,
    );
    if (!res.ok) throw new Error(`daemon subagents failed: ${res.status} ${await safeText(res)}`);
    return res.json();
  }

  /** Остановить прогон субагента. */
  async interruptSubagent(sessionId: string, runId: string): Promise<unknown> {
    const res = await this.request(
      `${this.base}/v1/host/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(runId)}/interrupt`,
      { method: "POST" },
    );
    if (!res.ok) {
      throw new Error(`daemon subagent interrupt failed: ${res.status} ${await safeText(res)}`);
    }
    return res.json();
  }

  /** Поиск по workspace. */
  async search(query: string, namesOnly: boolean): Promise<unknown> {
    const q = new URLSearchParams({ q: query });
    if (namesOnly) q.set("names", "1");
    const res = await this.request(`${this.base}/v1/host/search?${q.toString()}`);
    if (!res.ok) throw new Error(`daemon search failed: ${res.status} ${await safeText(res)}`);
    return res.json();
  }

  /** Каталог команд демона (split W12). */
  async commands(): Promise<unknown> {
    const res = await this.request(`${this.base}/v1/host/commands`);
    if (!res.ok) throw new Error(`daemon commands failed: ${res.status} ${await safeText(res)}`);
    return res.json();
  }

  /** Вьюер файла: байты + статус (ошибки вьюера отдаются текстом). */
  async fileView(
    path: string,
    download: boolean,
  ): Promise<{ status: number; mime: string; bytes: Uint8Array }> {
    const q = new URLSearchParams({ path });
    if (download) q.set("download", "1");
    const res = await this.request(`${this.base}/v1/host/file?${q.toString()}`);
    return {
      status: res.status,
      mime: res.headers.get("content-type") ?? "application/octet-stream",
      bytes: new Uint8Array(await res.arrayBuffer()),
    };
  }

  /** Очередь сессии: id сообщений в FIFO-порядке. */
  async queue(sessionId: string): Promise<{ queued: number; ids: string[] }> {
    const res = await this.request(
      `${this.base}/v1/host/sessions/${encodeURIComponent(sessionId)}/queue`,
    );
    if (!res.ok) throw new Error(`daemon queue failed: ${res.status} ${await safeText(res)}`);
    return (await res.json()) as { queued: number; ids: string[] };
  }

  /** Действие очереди: `cancel|edit|start`; статус возвращается как есть. */
  async queueAction(
    sessionId: string,
    action: "cancel" | "edit" | "start",
    id: string,
    text?: string,
  ): Promise<{ status: number; body: unknown }> {
    const res = await this.request(
      `${this.base}/v1/host/sessions/${encodeURIComponent(sessionId)}/queue/${action}`,
      { method: "POST", body: JSON.stringify({ id, ...(text !== undefined ? { text } : {}) }) },
    );
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  /** Провайдеры (split W11). */

  protected get base(): string {
    return this.opts.baseUrl.replace(/\/+$/, "");
  }

  protected request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Mma-Locale": this.locale,
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    return fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(30_000) });
  }

  /** Локаль клиента: явная опция, иначе текущая локаль процесса. */
  protected get locale(): string {
    return this.opts.locale ?? getLocale();
  }
}
