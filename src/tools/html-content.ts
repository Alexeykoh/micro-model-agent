/**
 * Извлечение основного текста из HTML и детект JS-шеллов — zero-dependency.
 *
 * `web_fetch` раньше отдавал `stripHtml` (все теги + навбар/футер) как
 * «успех», поэтому SPA-шелл и контентная страница были неразличимы, и модель
 * принимала навигацию за данные. Здесь: выбрать плотнейший main/article,
 * отбросить boilerplate и помечать страницы, где текста почти нет, а разметки
 * много (признак JS-рендеринга).
 */

/** Ниже этого объёма текста страница считается «без содержательного контента». */
export const MIN_CONTENT_CHARS = 200;
/** Страница с таким объёмом HTML, но без текста — почти наверняка JS-шелл. */
export const MIN_HTML_CHARS_FOR_SHELL = 2000;

const DROP_ELEMENTS =
  /<(script|style|noscript|svg|template|nav|header|footer|aside|form|iframe)[\s\S]*?<\/\1>/gi;

/** HTML-фрагмент → плоский текст с сохранением границ блоков как переводов строк. */
function htmlToText(fragment: string): string {
  return fragment
    .replace(DROP_ELEMENTS, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|section|article|tr|ul|ol|table|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\r\f\v]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Достаёт текст основного блока (`<main>`/`<article>`/`[role=main]`) по
 * наибольшей длине; фолбэк — всё тело документа. Без парсера: regex-грабями.
 */
export function extractMainContent(html: string): string {
  const candidates: string[] = [];
  const mainRe = /<(main|article)\b[\s\S]*?<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = mainRe.exec(html)) !== null) candidates.push(m[0]);
  const roleMain = /<[^>]*\brole\s*=\s*["']main["'][^>]*>[\s\S]*?<\/[^>]+>/i.exec(html);
  if (roleMain) candidates.push(roleMain[0]);

  let best = "";
  for (const c of candidates) {
    const text = htmlToText(c);
    if (text.length > htmlToText(best).length) best = c;
  }
  if (best && htmlToText(best).length >= MIN_CONTENT_CHARS) return htmlToText(best);

  const bodyM = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const whole = htmlToText(bodyM ? bodyM[1] : html);
  // Если main дал хоть что-то осмысленное — он и есть контент; иначе тело.
  return whole.length > 0 ? whole : htmlToText(best);
}

/**
 * JS-шелл: разметки много, текста почти нет. Настоящая маленькая страница
 * имеет и мало разметки, поэтому под эвристику не попадает.
 */
export function looksLikeShell(rawHtml: string, text: string): boolean {
  return text.trim().length < MIN_CONTENT_CHARS && rawHtml.length > MIN_HTML_CHARS_FOR_SHELL;
}
