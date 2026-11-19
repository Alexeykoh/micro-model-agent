// Встроенные сценарии сертификации — файловые операции.
// Данные вынесены из `scenarios.ts` (правило ≤300), порядок сохранён.
import type { ScenarioDef } from "./scenarios-def";

export const FILE_SCENARIOS: ScenarioDef[] = [
  {
    id: "2.1-read-file",
    title: "Read file content",
    tags: ["core"],
    mode: "run",
    prompt:
      'Create a file secret.ts with content: export const key = "abc123". Then use read_file to read it and create a file result.txt with the exact content of the key variable (just the string value abc123).',
    checks: [
      { type: "fileExists", path: "secret.ts" },
      { type: "fileExists", path: "result.txt" },
      { type: "fileContent", path: "result.txt", contains: "abc123" },
    ],
  },
  {
    id: "2.2-create-file",
    title: "Create single file",
    tags: ["core"],
    mode: "run",
    prompt: 'Create a file hello.ts with content: export const msg = "Hello, MMA!";',
    checks: [
      { type: "fileExists", path: "hello.ts" },
      { type: "fileContent", path: "hello.ts", contains: "Hello, MMA!" },
    ],
  },
  {
    id: "2.3-create-dir-file",
    title: "Create directory and file",
    tags: ["core"],
    mode: "run",
    prompt:
      "Create directory src/utils and file src/utils/helper.ts with content: export const add = (a: number, b: number) => a + b;",
    checks: [
      { type: "dirExists", path: "src/utils" },
      { type: "fileExists", path: "src/utils/helper.ts" },
      { type: "fileContent", path: "src/utils/helper.ts", contains: "a + b" },
    ],
  },
  {
    id: "2.4-edit-file",
    title: "Create then edit file",
    tags: ["core"],
    mode: "run",
    prompt:
      "Create helpers.ts with functions add and subtract. Then edit the add function to also log its arguments with console.log before returning.",
    checks: [
      { type: "fileExists", path: "helpers.ts" },
      { type: "fileRegex", path: "helpers.ts", pattern: "console\\.log" },
    ],
  },
  {
    id: "2.5-read-edit-chain",
    title: "Read existing file then edit it",
    tags: ["core"],
    mode: "run",
    prompt:
      'Create file config.json with content: {"version": 1, "debug": false}. Then use read_file to read it, and edit the file to change "debug" from false to true. Verify the final file contains "debug": true.',
    checks: [
      { type: "fileExists", path: "config.json" },
      { type: "fileContent", path: "config.json", contains: '"debug": true' },
      { type: "fileContent", path: "config.json", contains: '"version": 1' },
    ],
  },
  {
    id: "2.6-move-file",
    title: "Move/rename file",
    tags: ["core"],
    mode: "run",
    prompt: 'Create file old-name.txt with content "test". Rename it to new-name.txt.',
    checks: [
      { type: "fileNotExists", path: "old-name.txt" },
      { type: "fileExists", path: "new-name.txt" },
      { type: "fileContent", path: "new-name.txt", contains: "test" },
    ],
  },
  {
    id: "2.7-delete-file",
    title: "Delete a file",
    tags: ["core"],
    mode: "run",
    prompt:
      'Create file disposable.txt with content "temp". Then delete it using delete_file. Verify the file no longer exists.',
    checks: [
      { type: "fileNotExists", path: "disposable.txt" },
    ],
  },
  {
    id: "2.8-create-dir",
    title: "Create directory standalone",
    tags: ["core"],
    mode: "run",
    prompt:
      "Create the directory structure deep/nested/path using create_dir. Then create a file deep/nested/path/leaf.ts with content: export default 42;",
    checks: [
      { type: "dirExists", path: "deep/nested/path" },
      { type: "fileExists", path: "deep/nested/path/leaf.ts" },
      { type: "fileContent", path: "deep/nested/path/leaf.ts", contains: "42" },
    ],
  },
  {
    id: "2.9-list-dir",
    title: "List directory contents",
    tags: ["core"],
    mode: "run",
    prompt:
      'Create files a.txt, b.txt, c.txt in the root. Then use list_dir to list the current directory and create a file listing.txt that contains the names of all three files.',
    fixtures: [],
    checks: [
      { type: "fileExists", path: "a.txt" },
      { type: "fileExists", path: "b.txt" },
      { type: "fileExists", path: "c.txt" },
      { type: "fileExists", path: "listing.txt" },
      { type: "fileContent", path: "listing.txt", contains: "a.txt" },
      { type: "fileContent", path: "listing.txt", contains: "b.txt" },
      { type: "fileContent", path: "listing.txt", contains: "c.txt" },
    ],
  },
  {
    id: "2.10-file-info",
    title: "Get file info",
    tags: ["core"],
    mode: "run",
    prompt:
      'Create a file known.ts with content: export const x = 1;. Then use file_info to get its size and save the result to info.txt.',
    checks: [
      { type: "fileExists", path: "known.ts" },
      { type: "fileExists", path: "info.txt" },
    ],
  },
  {
    id: "2.11-read-after-write",
    title: "Write then read back",
    tags: ["core"],
    mode: "run",
    prompt:
      'Create a file verify.ts with content: export const x = 42;. Then use read_file to read it and confirm the content is correct.',
    checks: [
      { type: "fileExists", path: "verify.ts" },
      { type: "fileContent", path: "verify.ts", contains: "42" },
    ],
  },
  {
    id: "2.12-glob-search",
    title: "Find files by pattern",
    tags: ["core"],
    mode: "run",
    prompt:
      "Create three files: src/a.ts, src/b.ts, lib/c.ts (each with any content). Use the glob tool to find all .ts files under src/. Write the count (just the number) to count.txt.",
    checks: [
      { type: "fileExists", path: "src/a.ts" },
      { type: "fileExists", path: "src/b.ts" },
      { type: "fileExists", path: "lib/c.ts" },
      { type: "fileExists", path: "count.txt" },
      { type: "fileContent", path: "count.txt", equals: "2" },
    ],
  },
  {
    id: "2.13-grep-content",
    title: "Search file contents",
    tags: ["core"],
    mode: "run",
    prompt:
      'Create config.json with content: {"debug": true, "port": 3000}. Use the grep tool to search for "port" in all files. Write the found port value to found.txt.',
    checks: [
      { type: "fileExists", path: "config.json" },
      { type: "fileExists", path: "found.txt" },
      { type: "fileContent", path: "found.txt", contains: "3000" },
    ],
  },
];
