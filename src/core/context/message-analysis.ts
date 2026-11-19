// Анализ сообщений истории для компакции: классификация вставленной ошибки
// (feedback vs инструкция) и извлечение повторов «пробовали и не вышло» (H12/H13).
// Вынесено из `manager.ts` (правило ≤300 строк; потолок файла уже на пределе).
import { getMessageText } from "../../llm/provider";
import { truncate } from "../../utils/truncate";
import { summarizeArgs } from "./ledger-absorb";
import type { Message } from "./manager";

/** Запись "пробовали и не вышло": тул, args, ошибка, счётчик повторов. */
export interface TriedAndFailed {
  tool: string;
  args: string;
  error: string;
  count: number;
}

/** Структурная проверка: похоже ли сообщение юзера на вставленную ошибку/лог. */
export function looksLikeErrorPaste(text: string): boolean {
  // Маркеры ошибок.
  if (
    /(?:^|\s)ERROR|Error:|error TS\d+|Transform failed|\[plugin:|SyntaxError|Cannot find|Uncaught|exception/i.test(
      text,
    )
  ) {
    return true;
  }
  // Структурные сигналы вставленного вывода компилятора/рантайма: фреймы
  // исходников ("270|  }_s(...)"), ссылки path:line:col и строки стектрейсов.
  if (/(?:^|\n)\s*\d+\s*\|/.test(text)) return true;
  if (/[\w./\\-]+\.[a-z]{1,6}:\d+:\d+/.test(text)) return true;
  if (/(?:^|\n)\s*at\s+\S+/.test(text)) return true;
  return false;
}

/** Извлекает повторы "пробовали и не вышло" (≥2 фейлов одного тула+args). */
export function extractTriedAndFailed(messages: Message[]): TriedAndFailed[] {
  const failures: Map<string, TriedAndFailed> = new Map();

  for (const msg of messages) {
    if (msg.role === "tool" && msg.name && msg.success === false) {
      // Заблокированные плагином вызовы — решения гардов, не попытки: транзиентный
      // гард (или его баг) нельзя запоминать как "пробовали и не вышло — НЕ повторять"
      // (было: ложный plan-alignment блок заставил модель отказываться переписывать
      // файл собственного шага).
      if (msg.blocked) continue;
      const key = `${msg.name}:${summarizeArgs(msg.arguments)}`;
      const existing = failures.get(key);
      const errorText = truncate(
        typeof msg.content === "string" ? msg.content : getMessageText(msg.content),
        100,
      );
      if (existing) {
        existing.count++;
      } else {
        failures.set(key, {
          tool: msg.name,
          args: summarizeArgs(msg.arguments),
          error: errorText,
          count: 1,
        });
      }
    }
  }

  return Array.from(failures.values()).filter((f) => f.count >= 2);
}
