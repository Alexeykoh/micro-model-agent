// Встроенные сценарии сертификации — shell и research.
// Данные вынесены из `scenarios.ts` (правило ≤300), порядок сохранён.
import type { ScenarioDef } from "./scenarios-def";

export const SHELL_SCENARIOS: ScenarioDef[] = [
  // ─── Shell ───────────────────────────────────────────────────────────
  {
    id: "5.1-bash-grep",
    title: "Bash with grep pipe",
    tags: ["shell"],
    mode: "run",
    prompt:
      'Run the command echo "hello world" | grep hello using the bash tool. Write the output to result.txt.',
    checks: [
      { type: "fileExists", path: "result.txt" },
      { type: "fileContent", path: "result.txt", contains: "hello" },
    ],
  },
  {
    id: "5.2-bg-process",
    title: "Background process lifecycle",
    tags: ["shell"],
    mode: "run",
    prompt:
      "Start a long-running process in the background: sleep 15. Then list background processes to confirm it is running. Then kill it.",
    checks: [{ type: "exitCode", code: 0 }],
  },

  // ─── Subagent fan-out ────────────────────────────────────────────────
  {
    id: "7.2-parallel-subagents",
    title: "Two independent subagents deliver files in parallel",
    tags: ["core"],
    mode: "run",
    prompt:
      "Delegate two independent file creations, one per subagent, and run both subagent calls in the same batch (parallel): file-a.txt with content 'alpha' and file-b.txt with content 'beta'. Verify both files exist after the subagents complete.",
    checks: [
      { type: "fileExists", path: "file-a.txt" },
      { type: "fileExists", path: "file-b.txt" },
      { type: "fileContent", path: "file-a.txt", contains: "alpha" },
      { type: "fileContent", path: "file-b.txt", contains: "beta" },
    ],
  },

  // ─── Research ────────────────────────────────────────────────────────
  {
    id: "6.2-project-map",
    title: "Project map summary",
    tags: ["research"],
    mode: "run",
    prompt:
      'Use the project_map tool with action summary. Write the output to map-summary.txt.',
    checks: [
      { type: "fileExists", path: "map-summary.txt" },
      { type: "exitCode", code: 0 },
    ],
  },
  {
    id: "6.3-download-file",
    title: "Download a file",
    tags: ["research"],
    mode: "run",
    prompt:
      'Download https://httpbin.org/robots.txt to robots.txt using the download_file tool.',
    checks: [
      { type: "fileExists", path: "robots.txt" },
      { type: "fileContent", path: "robots.txt", contains: "User-agent" },
    ],
  },
];
