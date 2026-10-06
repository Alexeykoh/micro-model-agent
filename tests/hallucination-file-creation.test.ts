import { describe, it, expect } from "vitest";
import {
  checkClaimedFileCreation,
  taskExpectsFile,
} from "../src/modules/hallucination/file-creation-claim";

const TASK = "собери информацию в md файл с ценами";

describe("taskExpectsFile", () => {
  it("detects file intent", () => {
    expect(taskExpectsFile(TASK)).toBe(true);
    expect(taskExpectsFile("save this to report.md")).toBe(true);
  });
  it("has no file intent for a plain explanation", () => {
    expect(taskExpectsFile("объясни статью про велосипеды")).toBe(false);
  });
});

describe("checkClaimedFileCreation", () => {
  it("flags a saved-file claim with no write/edit tool", () => {
    const res = checkClaimedFileCreation(
      "Готово! Файл сохранён в /workspace/bike3/specialized_bikes_minsk.md",
      [{ name: "web_browse", ok: true, text: "page" }],
      TASK,
    );
    expect(res?.tool).toBe("file-creation");
    expect(res?.snippet).toContain("specialized_bikes_minsk.md");
  });

  it("passes when a write/edit tool ran this turn", () => {
    expect(
      checkClaimedFileCreation(
        "Файл сохранён в /workspace/bike3/out.md",
        [
          { name: "web_browse", ok: true, text: "page" },
          { name: "write_file", ok: true, text: "Written out.md" },
        ],
        TASK,
      ),
    ).toBeNull();
  });

  it("never fires when the task did not ask for a file", () => {
    expect(
      checkClaimedFileCreation(
        "Файл config.json сохранён в /etc/app/config.json",
        [{ name: "read_file", ok: true, text: "x" }],
        "объясни как работает приложение",
      ),
    ).toBeNull();
  });

  it("ignores file mentions inside fenced code blocks", () => {
    const response = ["Вот содержимое:", "```md", "Файл сохранён в report.md", "```"].join("\n");
    expect(
      checkClaimedFileCreation(response, [{ name: "read_file", ok: true, text: "x" }], TASK),
    ).toBeNull();
  });

  it("ignores a file mention in a documentation/article context", () => {
    expect(
      checkClaimedFileCreation(
        "В статье описан config.json, который создаётся при старте сервиса.",
        [{ name: "web_browse", ok: true, text: "page" }],
        "прочитай статью и собери конспект в файл",
      ),
    ).toBeNull();
  });
});
