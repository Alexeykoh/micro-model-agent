/**
 * Настройки через `RemoteHost` (split W11): визард, LSP, провайдеры, MCP,
 * память и плагины. Базовый транспорт — `RemotePanelClient`.
 */
import { safeText } from "./remote-host-types";
import { RemotePanelClient } from "./remote-host-panels";

export abstract class RemoteSettingsClient extends RemotePanelClient {

  async setup(): Promise<unknown> {
    const res = await this.request(`${this.base}/v1/host/setup`);
    if (!res.ok) throw new Error(`daemon setup failed: ${res.status} ${await safeText(res)}`);
    return res.json();
  }

  /** Визард: применение ответов и пробы (split W11). */
  async setupApply(answers: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    return this.jsonCall("/v1/host/setup", "POST", answers);
  }

  async setupScan(): Promise<unknown> {
    const res = await this.request(`${this.base}/v1/host/setup/scan`, { method: "POST" });
    if (!res.ok) throw new Error(`daemon setup scan failed: ${res.status} ${await safeText(res)}`);
    return res.json();
  }

  async setupModels(input: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    return this.jsonCall("/v1/host/setup/models", "POST", input);
  }

  async setupTest(input: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    return this.jsonCall("/v1/host/setup/test", "POST", input);
  }

  async setupContext(input: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    return this.jsonCall("/v1/host/setup/context", "POST", input);
  }

  async setupLocale(locale: string): Promise<{ status: number; body: unknown }> {
    return this.jsonCall("/v1/host/setup/locale", "POST", { locale });
  }

  async reindex(): Promise<unknown> {
    const res = await this.request(`${this.base}/v1/host/index`, { method: "POST" });
    if (!res.ok) throw new Error(`daemon index failed: ${res.status} ${await safeText(res)}`);
    return res.json();
  }

  async lspServers(): Promise<unknown> {
    const res = await this.request(`${this.base}/v1/host/lsp`);
    if (!res.ok) throw new Error(`daemon lsp failed: ${res.status} ${await safeText(res)}`);
    return res.json();
  }

  async lspDoctorGet(): Promise<unknown> {
    const res = await this.request(`${this.base}/v1/host/lsp/doctor`);
    if (!res.ok) throw new Error(`daemon lsp doctor failed: ${res.status} ${await safeText(res)}`);
    return res.json();
  }

  /** Запуск диагностики: 202 + SSE `lsp` (результат — в кэше). */
  async lspDoctorRun(): Promise<{ status: number; body: unknown }> {
    return this.jsonCall("/v1/host/lsp/doctor", "POST");
  }

  /** Диагностика одного файла. */
  async lspCheck(path: string): Promise<{ status: number; body: unknown }> {
    return this.jsonCall("/v1/host/lsp/check", "POST", { path });
  }

  /** Диагностика изменённых файлов. */
  async lspCheckChanged(): Promise<{ status: number; body: unknown }> {
    return this.jsonCall("/v1/host/lsp/check-changed", "POST");
  }

  /** Правка LSP-сервера. */
  async lspUpdate(
    lang: string,
    patch: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    return this.jsonCall(`/v1/host/lsp/${encodeURIComponent(lang)}`, "PUT", patch);
  }

  async providers(): Promise<unknown> {
    const res = await this.request(`${this.base}/v1/host/providers`);
    if (!res.ok) throw new Error(`daemon providers failed: ${res.status} ${await safeText(res)}`);
    return res.json();
  }

  async saveProvider(input: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const res = await this.request(`${this.base}/v1/host/providers`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  async deleteProvider(name: string): Promise<{ status: number; body: unknown }> {
    const res = await this.request(
      `${this.base}/v1/host/providers/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  /** MCP-серверы (split W11). */
  async mcpList(): Promise<unknown> {
    const res = await this.request(`${this.base}/v1/host/mcp`);
    if (!res.ok) throw new Error(`daemon mcp failed: ${res.status} ${await safeText(res)}`);
    return res.json();
  }

  async mcpCreate(input: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    return this.mcpCall("", "POST", input);
  }

  async mcpToggle(id: string, enabled: boolean): Promise<{ status: number; body: unknown }> {
    return this.mcpCall(`/${encodeURIComponent(id)}`, "POST", { enabled });
  }

  async mcpUpdate(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    return this.mcpCall(`/${encodeURIComponent(id)}`, "PUT", patch);
  }

  async mcpDelete(id: string): Promise<{ status: number; body: unknown }> {
    return this.mcpCall(`/${encodeURIComponent(id)}`, "DELETE");
  }

  private async mcpCall(
    suffix: string,
    method: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const res = await this.request(`${this.base}/v1/host/mcp${suffix}`, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  /** Память: дописать запись. */
  async memoryAdd(category: string, text: string): Promise<{ status: number; body: unknown }> {
    const res = await this.request(`${this.base}/v1/host/memory`, {
      method: "POST",
      body: JSON.stringify({ category, text }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  /** Память: удалить n-ю запись категории. */
  async memoryDelete(category: string, n: number): Promise<{ status: number; body: unknown }> {
    const res = await this.request(
      `${this.base}/v1/host/memory/${encodeURIComponent(category)}/${encodeURIComponent(String(n))}`,
      { method: "DELETE" },
    );
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  /** Плагины (split W11). */
  async pluginToggle(name: string, enabled: boolean): Promise<{ status: number; body: unknown }> {
    return this.jsonCall(`/v1/host/plugins/${encodeURIComponent(name)}`, "POST", { enabled });
  }

  async pluginSettingsGet(name: string): Promise<{ status: number; body: unknown }> {
    return this.jsonCall(`/v1/host/plugins/${encodeURIComponent(name)}/settings`, "GET");
  }

  async pluginSettingsPut(
    name: string,
    values: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    return this.jsonCall(`/v1/host/plugins/${encodeURIComponent(name)}/settings`, "PUT", {
      values,
    });
  }

  async pluginsReload(): Promise<{ status: number; body: unknown }> {
    return this.jsonCall("/v1/host/reload/plugins", "POST");
  }

  private async jsonCall(
    path: string,
    method: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const res = await this.request(`${this.base}${path}`, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
}
