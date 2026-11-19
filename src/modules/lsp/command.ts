// Реэкспорт Windows-запуска команд из общей утилиты (`src/utils/spawn-command.ts`):
// та же политика нужна MCP-клиенту, который стартует серверы через `npx`.
export { resolveSpawnCommand, buildWinCommandLine, spawnSpec } from "../../utils/spawn-command";
export type { SpawnSpec } from "../../utils/spawn-command";
