/**
 * Скоупинг сессий `mma web` по проекту (спека
 * `docs/specs/2026-11-12-webui-sessions-project-scope-design.md`).
 *
 * Разбор ses_mwdlv8tg_… (2026-11-12): в webui проекта A висели сессии проекта
 * B, и «продолжить» выполняло ход контекстом B — агент правил чужой каталог.
 * Тест держит три вещи: список фильтруется, `projectDir` доезжает до UI, и ход
 * в чужую сессию отвергается до спавна раннера.
 */
import { describe, it, expect } from "vitest";
import { inWorkspace, normalizeProjectPath } from "../src/modules/webui/session/project-scope";
import { createWebUiState } from "../src/modules/webui/state";
import { doFetch, postJson, withServer } from "./helpers/webui-server";

const PROJECT = "C:\\projects\\alpha";
const OTHER = "C:\\projects\\beta";

interface Meta {
  id: string;
  name: string;
  projectDir?: string;
}

function managerOf(metas: Meta[]) {
  const alive = new Map(metas.map((m) => [m.id, m]));
  return {
    list: () => [...alive.values()] as never,
    get: (id: string) => (alive.get(id) ?? null) as never,
    getActive: () => metas[0]?.id ?? null,
    setActive: () => {},
    delete: (id: string) => {
      alive.delete(id);
    },
  };
}

function stateWith(metas: Meta[]) {
  const s = createWebUiState();
  s.workspace = PROJECT;
  s.minPostIntervalMs = 0;
  s.sessionManager = managerOf(metas);
  return s;
}

function startedTurns(s: ReturnType<typeof createWebUiState>): string[] {
  const started: string[] = [];
  s.pool.setFactory(
    (id: string) =>
      ({
        sessionId: id,
        agent: {
          run: (text: string) => {
            started.push(id + ":" + text);
            return new Promise(() => {});
          },
          shutdown: () => {},
        },
        contextManager: { addPendingImage: () => {} },
        execModule: { getActivePlan: () => null },
      }) as never,
  );
  return started;
}

describe("project scope helpers", () => {
  it("compares paths case- and separator-insensitively", () => {
    expect(inWorkspace({ projectDir: PROJECT + "\\" }, PROJECT)).toBe(true);
    expect(inWorkspace({ projectDir: "c:/projects/ALPHA" }, PROJECT)).toBe(true);
    expect(inWorkspace({ projectDir: OTHER }, PROJECT)).toBe(false);
    expect(normalizeProjectPath("C:\\projects\\alpha\\")).toBe(
      normalizeProjectPath("c:/projects/alpha"),
    );
  });

  it("keeps legacy sessions without projectDir visible", () => {
    expect(inWorkspace({}, PROJECT)).toBe(true);
    expect(inWorkspace({ projectDir: OTHER }, undefined)).toBe(true);
  });
});

describe("webui sessions scoped to the workspace", () => {
  it("lists only this project's sessions and carries projectDir", async () => {
    const s = stateWith([
      { id: "own1", name: "own", projectDir: PROJECT },
      { id: "foreign", name: "other project", projectDir: OTHER },
      { id: "legacy", name: "old" },
    ]);
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/sessions`);
      const body = (await res.json()) as {
        sessions: Array<{ id: string; projectDir?: string }>;
      };
      expect(body.sessions.map((x) => x.id)).toEqual(["own1", "legacy"]);
      expect(body.sessions[0].projectDir).toBe(PROJECT);
    });
  });

  it("refuses activation of a foreign session", async () => {
    const s = stateWith([
      { id: "own1", name: "own", projectDir: PROJECT },
      { id: "foreign", name: "other", projectDir: OTHER },
    ]);
    await withServer(s, async (base) => {
      const foreign = await postJson(base, "/api/sessions/activate", { id: "foreign" });
      expect(foreign.status).toBe(403);
      expect(foreign.json.error).toBe("foreign_project");
      const own = await postJson(base, "/api/sessions/activate", { id: "own1" });
      expect(own.status).toBe(200);
    });
  });

  it("refuses a turn in a foreign session before spawning a runner", async () => {
    const s = stateWith([
      { id: "own1", name: "own", projectDir: PROJECT },
      { id: "foreign", name: "other", projectDir: OTHER },
    ]);
    const started = startedTurns(s);
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/message", { text: "hi", sessionId: "foreign" });
      expect(res.status).toBe(403);
      expect(res.json.error).toBe("foreign_project");
      await postJson(base, "/api/message", { text: "hi", sessionId: "own1" });
    });
    // Чужой слот не запускался: ход ушёл бы в каталог другого проекта.
    expect(started.some((x) => x.startsWith("foreign:"))).toBe(false);
    expect(started.some((x) => x.startsWith("own1:"))).toBe(true);
  });
});
