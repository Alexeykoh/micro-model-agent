// Встроенные сценарии сертификации — внешние каналы.
// Данные вынесены из `scenarios.ts` (правило ≤300), порядок сохранён.
import type { ScenarioDef } from "./scenarios-def";

export const EXTERNAL_SCENARIOS: ScenarioDef[] = [
  // ─── Image ───────────────────────────────────────────────────────────
  {
    id: "12.1-attach-image",
    title: "Attach image from file",
    tags: ["image"],
    mode: "run",
    prompt:
      "Use the attach_image tool to load test.png, then create a file description.txt with your description of the image.",
    fixtures: [{ source: "docs/testing/fixtures/test.png", dest: "test.png" }],
    checks: [{ type: "fileExists", path: "description.txt" }],
  },

  // ─── Network ─────────────────────────────────────────────────────────
  {
    id: "1.3-web-summary",
    title: "Web search and fetch summary",
    tags: ["network"],
    mode: "run",
    prompt:
      'Search for "TypeScript 5.5 new features", fetch the first result, and save a summary to summary.md.',
    checks: [{ type: "fileExists", path: "summary.md" }],
  },

  // ─── Browser ─────────────────────────────────────────────────────────
  {
    id: "1.10-browser-click",
    title: "Browser navigation and click",
    tags: ["browser"],
    mode: "run",
    prompt:
      'Open https://example.com with the browser tool. Click the "More information..." link. Then save the current page URL to page-url.txt.',
    checks: [
      { type: "fileExists", path: "page-url.txt" },
      { type: "fileRegex", path: "page-url.txt", pattern: "http" },
    ],
  },
];
