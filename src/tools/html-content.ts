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
export function htmlToText(fragment: string): string {
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
  return extractReadableContent(html).text;
}

/** Что удалось извлечь из HTML и откуда. */
export interface ReadableContent {
  /** Текст, который стоит показать модели. */
  text: string;
  /** Страница выглядит как JS-шелл: контента нет, а разметка есть. */
  shell: boolean;
  /** Откуда взят текст: `main` — контентный блок, `body` — всё тело, `none` — пусто. */
  source: "main" | "body" | "none";
}

/**
 * Извлечение читаемого содержимого (аудит §2.9).
 *
 * Ключевое отличие от прежнего поведения: если `<main>`/`<article>` ЕСТЬ, но
 * текста в нём мало, откат на `<body>` НЕ делается — иначе навигация выдавалась
 * за контент, и признак JS-шелла терялся (ровно тот случай, ради которого
 * файл написан). Тонкий `<main>` → `shell: true`.
 */
export function extractReadableContent(html: string): ReadableContent {
  const candidates: string[] = [];
  const mainRe = /<(main|article)\b[\s\S]*?<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = mainRe.exec(html)) !== null) candidates.push(m[0]);
  const roleMain = /<[^>]*\brole\s*=\s*["']main["'][^>]*>[\s\S]*?<\/[^>]+>/i.exec(html);
  if (roleMain) candidates.push(roleMain[0]);

  // Текст считаем один раз на кандидата (было пересчитывание в цикле).
  let bestText = "";
  for (const c of candidates) {
    const text = htmlToText(c);
    if (text.length > bestText.length) bestText = text;
  }

  if (candidates.length > 0) {
    return {
      text: bestText,
      shell: looksLikeShell(html, bestText),
      source: "main",
    };
  }

  const bodyM = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const whole = htmlToText(bodyM ? bodyM[1] : html);
  return {
    text: whole,
    shell: looksLikeShell(html, whole),
    source: whole.length > 0 ? "body" : "none",
  };
}

/** Доля текста в разметке, ниже которой страница считается JS-шеллом. */
export const MIN_TEXT_RATIO = 0.02;

/**
 * JS-шелл: текста почти нет, а разметка есть. Настоящая маленькая страница
 * имеет и мало разметки, поэтому под эвристику не попадает.
 *
 * Два признака: объём разметки (большая страница без текста) ИЛИ доля текста
 * в разметке (SPA-заглушка: `<div id="root">` и навигация, текста — ноль).
 * Второй признак ловит случай, который прежняя эвристика пропускала: откат
 * на `<body>` возвращал навигацию как «контент» (аудит §2.9).
 */
export function looksLikeShell(rawHtml: string, text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length >= MIN_CONTENT_CHARS) return false;
  if (rawHtml.length > MIN_HTML_CHARS_FOR_SHELL) return true;
  return trimmed.length / Math.max(rawHtml.length, 1) < MIN_TEXT_RATIO;
}
