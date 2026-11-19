// Guard: фоновая переиндексация обязана доезжать до панели «Карта».
//
// Регресс из стресс-теста (волна 20): вотчер пересобрал кэш за ~2 с
// (`.mma/index-cache.json`: 21 файл, builtAt 14:44), вкладка Files новый файл
// показала, а «Карта» продолжала рисовать `файлы 20 / обновлено 14:41`, пока не
// нажмёшь «Переиндексировать».
//
// Панель строится из `projectMap` снапшота `state`, поэтому колбэк вотчера
// обязан пушить state, а не только событие `files`.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("вотчер карты проекта в web", () => {
  const src = readFileSync("src/modules/webui/module.ts", "utf8");

  it("колбэк вотчера пушит state (свежий projectMap), а не только files", () => {
    const block = src.slice(src.indexOf("attachIndexWatcher(deps.indexer"));
    const body = block.slice(0, block.indexOf("});") + 3);

    expect(body).toContain("state.filesRevision += 1");
    expect(body).toContain('type: "files"');
    // Ключевая строка фикса: панель «Карта» живёт на снапшоте state.
    expect(body).toContain("pushState(state)");
  });
});
