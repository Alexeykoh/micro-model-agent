// Фрейминг недоверенного веб-контента (аудит §2.14).
//
// Страница из интернета — это ДАННЫЕ, а не инструкции. Без явной рамки модель
// читает «ignore previous instructions» в тексте страницы как указание. Рамка
// `<untrusted-web-content>` делает границу видимой и для модели, и для человека.

/** Открывающий тег рамки: источник виден модели. */
const OPEN = "untrusted-web-content";

/**
 * Оборачивает содержимое страницы в рамку недоверенных данных.
 * Закрывающий тег внутри тела экранируется, иначе содержимое может «закрыть»
 * рамку и вырваться за неё.
 */
export function wrapUntrusted(url: string, body: string): string {
  const source = escapeTag(url);
  // `<\/` в строке — это «</»: обратный слэш нужен буквальный, поэтому `\\`.
  const safeBody = body.split(`</${OPEN}>`).join(`<\\/${OPEN}>`);
  return `<${OPEN} source="${source}">\n${safeBody}\n</${OPEN}>`;
}

/** Снимает рамку (для расчётов по тексту: corpus, длины). */
export function unwrapUntrusted(text: string): string {
  const open = text.match(new RegExp(`^<${OPEN}(?:\\s[^>]*)?>\\n?`));
  if (!open) return text;
  const rest = text.slice(open[0].length);
  const close = rest.lastIndexOf(`</${OPEN}>`);
  return close >= 0 ? rest.slice(0, close).replace(/\n$/, "") : rest;
}

/** Экранирует спецсимволы, чтобы URL не ломал атрибут рамки. */
function escapeTag(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}
