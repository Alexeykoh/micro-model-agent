/**
 * Контрольные суммы идентификаторов (РФ/РБ). Только чистые функции — их
 * вызывают детекторы PII, чтобы отсеять случайные числа. УНП РБ и личный
 * номер РБ — без контрольной суммы (пониженный confidence, см. DEBT-регистр).
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

function checkDigit(digits: string, coef: number[], pos: number): boolean {
  let sum = 0;
  for (let i = 0; i < coef.length; i++) sum += coef[i] * Number(digits[i]);
  return sum % 11 % 10 === Number(digits[pos]);
}
