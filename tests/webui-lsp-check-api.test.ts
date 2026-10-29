// Guard: `POST /api/lsp/check` — путь из браузера, отказы данными (B-41, W1).
//
// Панель обязана получать диагностику файла и понятные коды: 200 с данными,
// 400 на путь вне workspace, 503 когда LSP-модуль не умеет проверять файлы.
import { describe, it, expect } from "vitest";
import { createWebUiState } from "../src/modules/webui/state";
import { withServer, postJson } from "./helpers/webui-server";

describe("webui: POST /api/lsp/check", () => {
  it("200 с диагностиками и 400 на выход из workspace", async () => {
    const s = createWebUiState();
    s.lspCheckFile = async (rel) =>
      rel.startsWith("..")
        ? { ok: false, path: rel, diagnostics: [], error: "outside-workspace" }
        : {
            ok: true,
            path: rel,
            diagnostics: [{ line: 5, column: 3, severity: "error", message: "boom" }],
            ms: 3,
          };

    await withServer(s, async (base) => {
      const ok = await postJson(base, "/api/lsp/check", { path: "src/a.ts" });
      expect(ok.status).toBe(200);
      expect(ok.json.ok).toBe(true);
      expect(Array.isArray(ok.json.diagnostics)).toBe(true);
      expect((ok.json.diagnostics as unknown[]).length).toBe(1);

      const bad = await postJson(base, "/api/lsp/check", { path: "../secret.txt" });
      expect(bad.status).toBe(400);
      expect(bad.json.error).toBe("outside-workspace");
    });
  });

  it("503, если модуль LSP не умеет проверять файл", async () => {
    const s = createWebUiState();

    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/lsp/check", { path: "src/a.ts" });
      expect(res.status).toBe(503);
      expect(res.json.error).toBe("unavailable");
    });
  });

  it("200 на «сервер запускается» — это не ошибка клиента", async () => {
    const s = createWebUiState();
    s.lspCheckFile = async (rel) => ({
      ok: false,
      path: rel,
      diagnostics: [],
      error: "starting",
      retryAfterMs: 2000,
    });

    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/lsp/check", { path: "src/main.ts" });
      expect(res.status).toBe(200);
      expect(res.json.error).toBe("starting");
      expect(res.json.retryAfterMs).toBe(2000);
    });
  });
});
