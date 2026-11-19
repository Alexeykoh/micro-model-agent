// Git-бейдж в строке футера под композером (спека git-workflow §6.3).
//
// Отдельный файл, а не добавка к `webui-workspace-footer.test.ts`: в том файле
// типизированный `Window` happy-dom живёт рядом с глобальным DOM, и LSP-гейт
// срывается на несвязанной несовместимости (`HTMLElement` vs `Node`), блокируя
// правку. Здесь та же проверка поведения, но через ГЛОБАЛЬНЫЙ `document` —
// без наследования этой проблемы.
//
// Предмет проверки один: git живёт В ТОЙ ЖЕ строке, что `dir` и версия
// (второй строки под композером быть не должно), и показывает ветку + счётчик.
import { describe, it, expect, beforeEach } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

// Побочный эффект: ставит глобали (window/document/HTMLElement…). Возвращаемое
// значение не используем — работаем через глобальный `document`.
setupHappyDom("");

const { renderFooter } = await import("../src/modules/webui/assets/js/footer.js");

/** Создатель элементов — тот же контракт, что у `dom.js` (`el`). */
function make(tag: string, cls: string, text: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = cls;
  node.textContent = text;
  return node;
}

const labels = { changes: "changes", detached: "detached" };

let line: HTMLElement;
beforeEach(() => {
  line = document.createElement("div");
  line.className = "ws-line";
  line.hidden = true;
  document.body.appendChild(line);
});

/** Рисует футер во временную строку с заданным git-состоянием. */
function draw(input: Record<string, unknown> = {}): void {
  renderFooter(line, { dirLabel: "dir", gitLabels: labels, ...input }, make);
}

describe("git badge in the footer line", () => {
  it("puts the branch and the change count in the dir line", () => {
    draw({
      workspace: "C:\\projects\\demo",
      version: "0.24.2",
      git: { repo: true, branch: "dev", dirty: 3 },
    });
    expect(line.querySelector(".gchip-branch")?.textContent).toBe("⎇ dev");
    expect(line.querySelector(".gchip-dirty")?.textContent).toBe("● 3 changes");
    // Подпись dir + путь + ветка + счётчик + версия — всё в одной `.ws-line`.
    expect(line.children.length).toBe(5);
    expect(line.querySelector(".ws-ver")?.textContent).toBe("mma 0.24.2");
  });

  it("keeps the branch but drops the counter on a clean tree", () => {
    draw({ workspace: "C:\\p", git: { repo: true, branch: "main", dirty: 0 } });
    expect(line.querySelector(".gchip-branch")?.textContent).toBe("⎇ main");
    // Ноль изменений не рисуем: «● 0» — шум, ветка уже говорит о состоянии.
    expect(line.querySelector(".gchip-dirty")).toBeNull();
  });

  it("renders nothing for git outside a repository", () => {
    draw({ workspace: "C:\\p", git: { repo: false } });
    expect(line.querySelector(".gchip")).toBeNull();
    // Посторонних узлов от git не остаётся: только подпись dir и путь.
    expect(line.children.length).toBe(2);
  });

  it("marks a detached HEAD and keeps the details in the tooltip", () => {
    draw({
      git: { repo: true, branch: "abc1234", detached: true, ahead: 2, behind: 1, tags: ["v1.0.0"] },
    });
    const branch = line.querySelector(".gchip-branch");
    expect(branch?.textContent).toBe("⎇ detached@abc1234");
    // Ahead/behind и теги — в подсказке: строка не должна спорить с путём.
    expect(branch?.getAttribute("title")).toContain("↑2 ↓1");
    expect(branch?.getAttribute("title")).toContain("v1.0.0");
  });

  it("never adds a second row under the composer", () => {
    draw({ workspace: "C:\\p", git: { repo: true, branch: "dev", dirty: 1 } });
    const chips = line.querySelectorAll(".gchip");
    expect(chips.length).toBe(2);
    // Ключевой инвариант: чипы — дети самой строки, а не соседнего блока.
    for (const chip of chips) expect(chip.parentElement).toBe(line);
  });

  it("rebuilds when the git state changes", () => {
    draw({ git: { repo: true, branch: "dev", dirty: 1 } });
    expect(line.querySelector(".gchip-dirty")?.textContent).toBe("● 1 changes");
    draw({ git: { repo: true, branch: "dev", dirty: 2 } });
    expect(line.querySelector(".gchip-dirty")?.textContent).toBe("● 2 changes");
  });

  it("keeps the line hidden when there is nothing at all to show", () => {
    draw({});
    expect(line.hidden).toBe(true);
    expect(line.children.length).toBe(0);
  });
});
