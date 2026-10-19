/**
 * Обратимая псевдонимизация: карта «значение ↔ токен» на сессию. Токены
 * **неперебираемы** (крипто-случайный hex, INV-D9); ре-гидратация — только по
 * точному попаданию. Карта делится форками (INV-D11) — это её владелец, один писатель.
 *
 * DEBT(data-policy-projection-lifecycle): карта живёт до конца процесса, не до
 * активного окна контекста (R6); мемоизации проекции по хэшу сообщения нет.
 */
import { randomBytes } from "node:crypto";
import type { DataClass } from "./types";

/** Метка класса в токене. */
const LABEL: Record<string, string> = {
  path: "PATH",
  machine: "HOST",
  env: "ENV",
  secret: "SECRET",
  pii: "PII",
  "file-content": "FILE",
};

/** Регулярка токенов: `<LABEL:hex>`. */
const TOKEN_RE = /<([A-Z]+):([0-9a-f]{8,})>/g;

/** Карта токенов (значение → токен и обратно). */
export class TokenMap {
  private valueToToken = new Map<string, string>();
  private tokenToValue = new Map<string, string>();

  /** Токен для значения (создаёт при первом обращении, идемпотентно). */
  tokenFor(value: string, dataClass: DataClass): string {
    const existing = this.valueToToken.get(value);
    if (existing) return existing;
    const label = LABEL[dataClass] ?? "DP";
    const token = `<${label}:${randomBytes(6).toString("hex")}>`;
    this.valueToToken.set(value, token);
    this.tokenToValue.set(token, value);
    return token;
  }

  /** Значение по токену, если он наш (иначе undefined — чужой токен не трогаем). */
  valueFor(token: string): string | undefined {
    return this.tokenToValue.get(token);
  }

  has(token: string): boolean {
    return this.tokenToValue.has(token);
  }

  get size(): number {
    return this.tokenToValue.size;
  }

  /** Снимок для диагностики (без оригинала: только количество и метки). */
  labels(): string[] {
    return [...this.tokenToValue.keys()].map((t) => t.replace(/:[0-9a-f]+\>$/, ">"));
  }
}

/**
 * Ре-гидратировать токены в тексте (аргументы тула, INV-D5). Неизвестный токен
 * остаётся как есть. `map === undefined` → текст без изменений.
 */
export function rehydrate(text: string, map: TokenMap | undefined): string {
  if (!map || text.indexOf("<") === -1) return text;
  return text.replace(TOKEN_RE, (whole) => map.valueFor(whole) ?? whole);
}

/** Заменить в тексте все токены на их значения (алиас `rehydrate`). */
export function rehydrateArgs(text: string, map: TokenMap | undefined): string {
  return rehydrate(text, map);
}
