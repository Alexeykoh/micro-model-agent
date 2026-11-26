/**
 * Контрольные суммы идентификаторов (РФ/РБ). Только чистые функции — их
 * вызывают детекторы PII, чтобы отсеять случайные числа.
 *
 * РБ: УНП — МНС №127 от 31.12.2003 (веса 29/23/19/17/13/7/5/3, mod 11),
 * личный номер — МВД №345 от 18.10.2011 (веса 731 по модулю 10, A..Z = 10..35).
 */

/** Алгоритм Луна: длина 13–19 цифр, сумма по модулю 10. */
export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** IBAN: mod-97 === 1 (ISO 13616). */
export function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let num = "";
  for (const ch of rearranged) {
    if (ch >= "A" && ch <= "Z") num += String(ch.charCodeAt(0) - 55);
    else num += ch;
  }
  try {
    return BigInt(num) % 97n === 1n;
  } catch {
    return false;
  }
}

/** СНИЛС: 11 цифр, контроль по предпоследним/последней цифрам. */
export function snilsValid(digits: string): boolean {
  if (!/^\d{11}$/.test(digits)) return false;
  const body = digits.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(body[i]) * (9 - i);
  let control: number;
  if (sum < 100) control = sum;
  else if (sum === 100 || sum === 101) control = 0;
  else {
    control = sum % 101;
    if (control === 100) control = 0;
  }
  return control === Number(digits.slice(9));
}

/** ИНН: 10 или 12 цифр. */
export function innValid(digits: string): boolean {
  if (/^\d{10}$/.test(digits)) {
    return checkDigit(digits, [2, 4, 10, 3, 5, 9, 4, 6, 8], 9);
  }
  if (/^\d{12}$/.test(digits)) {
    const d11 = checkDigit(digits, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 10);
    const d12 = checkDigit(digits, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 11);
    return d11 && d12;
  }
  return false;
}

/** ОГРН: 13 цифр (ОГРН) или 15 (ОГРНИП). */
export function ogrnValid(digits: string): boolean {
  if (/^\d{13}$/.test(digits)) {
    const base = Number(digits.slice(0, 12)) % 11;
    return base % 10 === Number(digits[12]);
  }
  if (/^\d{15}$/.test(digits)) {
    const base = BigInt(digits.slice(0, 14)) % 13n;
    return Number(base % 10n) === Number(digits[14]);
  }
  return false;
}

/** Кириллические гомоглифы латинских букв, встречающиеся в scanned-тексте. */
const CYRILLIC_TO_LATIN: Record<string, string> = {
  А: "A", В: "B", С: "C", Е: "E", Н: "H", К: "K", М: "M", О: "O", Р: "P", Т: "T",
};

function latinUpper(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[АВСЕНКМОРТ]/g, (ch) => CYRILLIC_TO_LATIN[ch] ?? ch);
}

const UNP_FIRST: Record<string, number> = { A: 10, B: 11, C: 12, E: 14, H: 17, K: 20, M: 22 };
const UNP_SECOND: Record<string, number> = {
  A: 0, B: 1, C: 2, E: 3, H: 4, K: 5, M: 6, O: 7, P: 8, T: 9,
};
const UNP_WEIGHTS = [29, 23, 19, 17, 13, 7, 5, 3];

/** УНП РБ: 9 знаков, восемь взвешенных + контрольная цифра по mod 11 (МНС №127). */
export function unpValid(raw: string): boolean {
  const s = latinUpper(raw);
  if (s.length !== 9 || !/^\d{7}$/.test(s.slice(2))) return false;
  const first = /^\d$/.test(s[0]) ? Number(s[0]) : UNP_FIRST[s[0]];
  const second = /^\d$/.test(s[1]) ? Number(s[1]) : UNP_SECOND[s[1]];
  if (first === undefined || second === undefined) return false;
  const values = [first, second, ...s.slice(2, 8).split("").map(Number)];
  const check = values.reduce((sum, value, i) => sum + value * UNP_WEIGHTS[i], 0) % 11;
  // Контрольная цифра 10 не используется — порядковый номер увеличивается.
  return check < 10 && check === Number(s[8]);
}

/** Личный номер РБ: 7 цифр + A + 3 цифры + PB + цифра, веса 731 по mod 10 (МВД №345). */
export function byIdValid(raw: string): boolean {
  const s = latinUpper(raw);
  if (!/^\d{7}A\d{3}PB\d$/.test(s)) return false;
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    const ch = s[i];
    const value = /^\d$/.test(ch) ? Number(ch) : ch.charCodeAt(0) - 55;
    sum += value * weights[i % weights.length];
  }
  return sum % 10 === Number(s[13]);
}

function checkDigit(digits: string, coef: number[], pos: number): boolean {
  let sum = 0;
  for (let i = 0; i < coef.length; i++) sum += coef[i] * Number(digits[i]);
  return sum % 11 % 10 === Number(digits[pos]);
}
