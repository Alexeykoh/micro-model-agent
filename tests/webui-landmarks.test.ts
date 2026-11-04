/**
 * U11: у приложения есть landmark `<main>` и skip-link, который первым ловит
 * Tab и переносит фокус к сообщениям.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const HTML = readFileSync(
  join(process.cwd(), "src/modules/webui/assets/index.html"),
  "utf-8",
);

describe("web ui landmarks (U11)", () => {
  it("wraps the chat in a main landmark", () => {
    expect(HTML).toMatch(/<main class="chat" id="main">/);
    expect(HTML).toMatch(/<\/main>/);
    expect(HTML).not.toMatch(/<div class="chat">/);
  });

  it("starts with a skip link to the messages", () => {
    expect(HTML).toMatch(/<a class="skip-link" href="#msgs">/);
    expect(HTML).toMatch(/id="msgs"[^>]*tabindex="-1"/);
  });
});
