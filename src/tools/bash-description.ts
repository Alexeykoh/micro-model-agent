/** Описание bash-тула по платформе: Windows-факты не должны утекать на POSIX. */

const BASE_DESCRIPTION =
  "Execute a shell command and return its output. Use for running tests, build, git, and shell operations. " +
  "Commands that are still running after a few seconds are automatically moved to the background and return a " +
  "process id — manage them with process_list, process_log, process_wait, process_kill. For a finite background " +
  "task prefer a single process_wait over polling process_log or sleeping (never use ping/timeout/sleep as a delay). " +
  "Set background=true to return a process id immediately for commands you know are long-running (dev servers, watchers, " +
  "scaffolding such as create-next-app/create-vite/shadcn init, and package installs such as npm install/bun install). " +
  "For scaffolding, never run create-next-app directly in a non-empty directory and never re-run the same scaffold command with just a version-flag change: check the help once, then run one command and wait with process_wait.";

const WINDOWS_NOTES =
  "Windows notes: the shell is cmd.exe — PowerShell cmdlets (Write-Host, Get-Content, Select-String, Out-File) " +
  "and bash heredocs (cat << EOF) do NOT work there. Use the read_file/write_file tools instead of cat/echo " +
  "redirection. Chaining and shell operators (| > >> ; &&) are blocked — run one plain command per tool call.";

/**
 * Описание bash-тула под платформу.
 * @param platformName платформа (`process.platform`); POSIX не получает cmd.exe-текст.
 */
export function buildBashDescription(platformName: NodeJS.Platform = process.platform): string {
  return platformName === "win32"
    ? `${BASE_DESCRIPTION}\n\n${WINDOWS_NOTES}`
    : BASE_DESCRIPTION;
}
