/**
 * Разбор клавиш строчного редактора: escape-последовательности → действие.
 * Вынесено из `line-editor.ts` (правило 6); порядок проверок и поглощение
 * CSI-u/DSR-последовательностей сохранены дословно.
 */

export type EditOp =
  | "backspace"
  | "delete"
  | "left"
  | "right"
  | "up"
  | "down"
  | "home"
  | "end"
  | "pageup"
  | "pagedown";

export type CtrlOp = "c" | "d" | "a" | "e" | "u" | "k" | "w" | "l";
export type MetaOp = "b" | "f" | "d";

/** Действие обычной клавиши (после paste-машины и хостового хука). */
export type KeyAction =
  | { kind: "ignore" }
  | { kind: "newline" }
  | { kind: "return" }
  | { kind: "enter" }
  | { kind: "edit"; op: EditOp }
  | { kind: "tab" }
  | { kind: "ctrl"; op: CtrlOp }
  | { kind: "meta"; op: MetaOp }
  | { kind: "insert"; text: string }
  | { kind: "none" };

interface KeyInfo {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
}

function info(str: string, key: unknown): { k: KeyInfo; name: string; seq: string } {
  const k = (key ?? {}) as KeyInfo;
  const name = k?.name ?? "undefined";
  const seq = k?.sequence ?? str ?? "";
  return { k, name, seq };
}

/** Имя/последовательность клавиши для paste-машины редактора. */
export function keyInfo(str: string, key: unknown): { name: string; seq: string } {
  const { name, seq } = info(str, key);
  return { name, seq };
}

/**
 * Ранние escape-ветки: kitty CSI-u (Ctrl+Enter как перевод строки) и DSR-ответ
 * `ESC[row;colR`, который не должен протекать в буфер. `null` — не наш случай.
 */
export function classifyEscape(name: string, seq: string): "newline" | "ignore" | null {
  if (name === "undefined" && /^\x1b\[\d+(?:;\d+)?u$/.test(seq)) {
    const m = seq.match(/^\x1b\[(\d+)(?:;(\d+))?u$/);
    if (m && Number(m[1]) === 13 && Number(m[2] ?? 0) !== 0) return "newline";
    return "ignore";
  }
  // Отчёт о позиции курсора (`ESC[row;colR`) — никогда не ввод: на части связок
  // Windows/ConPTY + Bun хвостовой "R" протекает в буфер и портит ответ
  // (каждый промпт отвечал "R"). Глотаем последовательность целиком.
  if (/^\x1b\[\d+;\d+R$/.test(seq)) return "ignore";
  return null;
}

const EDIT_KEYS: Record<string, EditOp> = {
  backspace: "backspace",
  delete: "delete",
  left: "left",
  right: "right",
  up: "up",
  down: "down",
  home: "home",
  end: "end",
  pageup: "pageup",
  pagedown: "pagedown",
};

const CTRL_KEYS: Record<string, CtrlOp> = {
  c: "c",
  d: "d",
  a: "a",
  e: "e",
  u: "u",
  k: "k",
  w: "w",
  l: "l",
};

const META_KEYS: Record<string, MetaOp> = { b: "b", f: "f", d: "d" };

/** Действие клавиши, попавшей в редактор (после ранних escape-веток). */
export function classifyKey(str: string, key: unknown): KeyAction {
  const { k, name, seq } = info(str, key);

  if (name === "return" && (seq === "\x1b\r" || k.meta)) return { kind: "newline" };
  if (name === "undefined" && seq === "\x1b\r") return { kind: "newline" };
  if (k?.ctrl && name === "j") return { kind: "newline" };
  if (name === "escape") return { kind: "ignore" };

  if (name === "return") return { kind: "return" };
  if (name === "enter") return { kind: "enter" };
  const edit = EDIT_KEYS[name];
  if (edit) return { kind: "edit", op: edit };
  if (name === "tab") return { kind: "tab" };

  if (k?.ctrl) {
    const op = CTRL_KEYS[name];
    return op ? { kind: "ctrl", op } : { kind: "ignore" };
  }

  if (k?.meta) {
    const op = META_KEYS[name];
    return op ? { kind: "meta", op } : { kind: "ignore" };
  }

  if (str && !/^[\u0000-\u001f\u007f]/.test(str)) return { kind: "insert", text: str };
  return { kind: "none" };
}
