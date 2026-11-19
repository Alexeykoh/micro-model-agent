// Guard: `mma changelog` обязан находить CHANGELOG.md и в исходном дереве.
//
// Регресс из стресс-теста (волна 18): команда печатала «Changelog не найден для
// этой установки», хотя `CHANGELOG.md` лежит в корне репозитория. Причина —
// путь к пакету получали вручную из `import.meta.url` (`slice("file://")`):
// на Windows оставался ведущий слэш `/E:/…`, и `existsSync(package.json)` не
// срабатывал ни на одном уровне.
import { describe, it, expect } from "vitest";
import { readChangelog, extractLatestChangelog } from "../../src/modules/updater/changelog-reader";

describe("чтение CHANGELOG из дерева репозитория", () => {
  it("readChangelog находит файл пакета micro-models-agent", () => {
    const text = readChangelog("micro-models-agent");

    expect(text).toBeTruthy();
    expect(String(text)).toContain("# Changelog");
    expect(String(text)).toMatch(/## \[0\./);
  });

  it("extractLatestChangelog отдаёт верхнюю секцию", () => {
    const text = readChangelog("micro-models-agent");
    const latest = extractLatestChangelog(String(text));

    expect(latest).toBeTruthy();
    expect(String(latest)).toMatch(/^## \[/);
  });

  it("неизвестный пакет по-прежнему null (без исключения)", () => {
    expect(readChangelog("definitely-not-this-package")).toBeNull();
  });
});
