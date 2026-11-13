/**
 * Job-клиент демона для one-shot `mma "prompt" --daemon <url>` (split W5).
 *
 * Использует существующий job API (`POST /v1/sessions/:id/tasks` +
 * `GET /v1/tasks/:jobId`), а не host wire: one-shot не нужен стрим, нужен
 * терминальный Job-объект. Форма ответа повторена локально, чтобы модуль
 * демона не зависел от `modules/service`.
 */

/** Терминальный Job-объект v1 (подмножество, нужное one-shot). */
export interface RemoteJobObject {
  jobId: string;
  status: string;
  result?: { text: string; data?: unknown };
  usage?: { promptTokens: number; completionTokens: number; costUsd: number };
  error?: { title?: string; detail?: string };
}

/** Параметры клиента: адрес демона, токен и тестовый fetch. */
export interface RemoteTasksOptions {
  baseUrl: string;
  token?: string | null;
  /** Интервал опроса статуса (мс); тестовый оверрайд. */
  pollMs?: number;
  /** Тестовый шов подмены сети. */
  fetchImpl?: typeof fetch;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

/** Ставит job-задачу и ждёт её терминального статуса. */
export class RemoteTasksClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: RemoteTasksOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async run(sessionId: string, input: string): Promise<RemoteJobObject> {
    const res = await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/tasks`, {
      method: "POST",
      body: JSON.stringify({ input, mode: "job", output: { format: "text" } }),
    });
    if (!res.ok) {
      throw new Error(`daemon task submit failed: ${res.status} ${await safeText(res)}`);
    }
    return this.wait(await res.json());
  }

  private async wait(job: RemoteJobObject): Promise<RemoteJobObject> {
    let current = job;
    while (!TERMINAL.has(current.status)) {
      await delay(this.opts.pollMs ?? 500);
      const res = await this.request(`/v1/tasks/${encodeURIComponent(current.jobId)}`);
      if (!res.ok) {
        throw new Error(`daemon task status failed: ${res.status} ${await safeText(res)}`);
      }
      current = (await res.json()) as RemoteJobObject;
    }
    return current;
  }

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    const base = this.opts.baseUrl.replace(/\/+$/, "");
    return this.fetchImpl(`${base}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
