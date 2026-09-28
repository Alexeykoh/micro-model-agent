// Детект dev-запуска по расширению точки входа (для запрета самообновления из чекаута).
/**
 * True, когда запущенная точка входа — TypeScript-исходник, т.е. dev-прогон
 * (`bun run src/cli/main.ts`, `bun --watch src/cli/main.ts`, tsx/ts-node).
 * Опубликованный пакет грузится как сбандленный `dist/main.js` через
 * `bin/mma.mjs`, так что для реальных установок это false.
 *
 * Dev-прогоны НЕ должны самообновляться: версия package.json в чекауте вправе
 * отставать от npm, а молча `npm install -g`-шить поверх пользовательского
 * глобала из dev-дерева — деструктивно и неожиданно.
 */
export function isDevEntryPath(path: string): boolean {
  const clean = path.split(/[?#]/)[0];
  return (
    clean.endsWith(".ts") ||
    clean.endsWith(".tsx") ||
    clean.endsWith(".mts") ||
    clean.endsWith(".cts")
  );
}
