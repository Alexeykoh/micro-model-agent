// Guard (A-01): автоочистка сессий фоновая, пачечная и не перебирает огромный
// каталог. Раньше create() синхронно удалял десятки тысяч каталогов и падал.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/modules/session/store";
import { SessionManager } from "../../src/modules/session/manager";
import { t } from "../../src/i18n/index";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SessionManager: фоновая автоочистка", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mma-autoprune-"));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  function manager(max: number, warn: (m: string) => void = () => {}): SessionManager {
    const store = new SessionStore(join(dir, "sessions"));
    store.init();
    return new SessionManager(store, {
      model: "m",
      contextWindow: 1024,
      projectDir: "/tmp",
      maxSessions: max,
      logger: { warn },
    });
  }

  it("create() возвращается до удаления, затем оставляет лимит", async () => {
    const m = manager(3);
    for (let i = 0; i < 10; i++) m.create(`s${i}`);

    // Синхронная часть не должна была удалять 7 сессий прямо в цикле.
    expect(m.list().length).toBe(10);

    await delay(40);
    expect(m.list().length).toBe(3);
  });

  it("каталог больше порога не сканируется: предупреждение вместо перебора", async () => {
    mkdirSync(join(dir, "sessions"), { recursive: true });
    for (let i = 0; i < 1005; i++) mkdirSync(join(dir, "sessions", `s${i}`));
    const warnings: string[] = [];
    const m = manager(3, (msg) => warnings.push(msg));

    m.create("new");
    await delay(40);

    expect(warnings.join("\n")).toContain(t("session.autoprune_skipped", { count: "1006", limit: "1000" }));
    // Ничего не удалено: массовая чистка — только явный `session prune`.
    expect(new SessionStore(join(dir, "sessions")).countSessions()).toBe(1006);
  });
});
