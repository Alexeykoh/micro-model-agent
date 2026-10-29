// Версия Node, которой запустится LSP-сервер, и совместимые пины пакетов.
//
// Зачем: JS-серверы (`typescript-language-server`, `pyright`, …) объявляют
// минимальный Node в `engines`, но npm по умолчанию ставит их с одним
// предупреждением `EBADENGINE`. Процесс потом падает на старте (`SyntaxError`,
// `ERR_REQUIRE_ESM`), и без версии рантайма это неотличимо от «битого конфига».
// Здесь — единственный источник правды: как прочитать версию и что советовать.
import { execSync } from "child_process";

/** Версия Node: как напечатал `node --version` и мажор. */
export interface NodeVersion {
  raw: string;
  major: number;
}

/**
 * Прочитать версию Node из PATH. `run` инжектируется для тестов.
 * null — node не найден/вывод не распознан (тогда и говорить нечего).
 */
export function readNodeVersion(
  command = "node",
  run: (cmd: string) => string = (cmd) =>
    execSync(cmd, { stdio: "pipe", timeout: 3000 }).toString(),
): NodeVersion | null {
  try {
    const out = run(`${command} --version`).trim();
    const match = /^v?(\d+)\./.exec(out);
    if (!match) return null;
    return { raw: out, major: Number(match[1]) };
  } catch {
    return null;
  }
}

/**
 * Сообщения, которыми JS-сервер падает на неподходящем рантайме. Классификация
 * по сообщению, а не по таблице «версия Node → версия пакета»: таблица устаревает
 * быстрее кода, а факт краха уже в тексте ошибки.
 */
const NODE_VERSION_CRASH =
  /SyntaxError|Unexpected token|ERR_REQUIRE_ESM|ERR_UNKNOWN_BUILTIN_MODULE|structuredClone is not defined/;

/** Похоже ли сообщение на крах JS-сервера из-за версии рантайма. */
export function looksLikeNodeVersionCrash(message: string): boolean {
  return NODE_VERSION_CRASH.test(message);
}

/**
 * Совместимые с Node < 18 пины пакетов. `typescript-language-server@3.3.2` —
 * последняя стабильная 3.x (`engines.node >=14.17`); 4.x требует Node 18+.
 */
const OLD_NODE_PINS: Record<string, string> = {
  "typescript-language-server": "typescript-language-server@3.3.2",
};

/** Пин пакета для старого Node; без известного пина — исходный спецификатор. */
export function pinForOldNode(pkg: string): string {
  const at = pkg.lastIndexOf("@");
  const name = at > 0 ? pkg.slice(0, at) : pkg;
  return OLD_NODE_PINS[name] ?? pkg;
}
