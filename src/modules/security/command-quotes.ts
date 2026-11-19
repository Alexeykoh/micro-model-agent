// Маскирование содержимого кавычек в строке shell-команды.

/**
 * Маскирует содержимое кавычек, оставляя видимыми только символы, которые
 * shell исполняет И внутри двойных кавычек.
 *
 * Символы `& | ; > <` внутри кавычек — данные, а не операторы: URL с
 * `?a=1&b=2` и `--format "{{.Names}} | {{.Image}}"` не являются цепочкой
 * команд. НО `$(...)` и обратные кавычки внутри `"…"` shell исполняет, поэтому
 * они сохраняются (иначе `echo "$(rm -rf /)"` обошёл бы проверку операторов).
 * Внутри одинарных кавычек инертно всё.
 *
 * @param command сырая строка команды.
 * @returns строка той же длины, где содержимое кавычек замаскировано пробелами.
 */
export function maskQuotedShell(command: string): string {
  const out: string[] = [];
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      out.push(ch === "'" ? ch : " ");
      continue;
    }
    if (quote === '"') {
      // Внутри двойных кавычек shell исполняет только `$(...)` и обратные
      // кавычки. Обратный слэш экранирует кавычку, но `\|` остаётся данными —
      // поэтому здесь он не «расшивает» следуюший символ.
      if (ch === "\\" && command[i + 1] === '"') {
        out.push(" ");
        out.push(" ");
        i++;
        continue;
      }
      if (ch === '"') quote = null;
      out.push(ch === '"' ? ch : ch === "$" || ch === "`" ? ch : " ");
      continue;
    }
    // Вне кавычек: экранированный символ — литерал, кавычка — начало строки.
    if (ch === "\\") {
      out.push(ch);
      if (i + 1 < command.length) out.push(command[++i]);
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out.push(ch);
      continue;
    }
    out.push(ch);
  }
  return out.join("");
}

