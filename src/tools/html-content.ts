/**
 * Извлечение основного текста из HTML и детект JS-шеллов — zero-dependency.
 *
 * `web_fetch` раньше отдавал `stripHtml` (все теги + навбар/футер) как
 * «успех», поэтому SPA-шелл и контентная страница были неразличимы, и модель
 * принимала навигацию за данные. Здесь: выбрать плотнейший main/article,
 * отбросить boilerplate и помечать страницы, где текста почти нет, а разметки
 * много (признак JS-рендеринга).
 */

/** Сколько Offer-ов из JSON-LD показывать перед обрезкой вывода web_fetch. */
const MAX_STRUCTURED_OFFERS = 20;
/** Длина описания Offer-а в компактной строке. */
const MAX_OFFER_DESCRIPTION = 100;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Достаёт цены/тарифы из JSON-LD (`OfferCatalog`), которые лежат в `<script>`
 * и потому теряются при извлечении видимого текста. Сессия GYM24 искала
 * «4 посещения» по агрегаторам только потому, что нужные офферы были ниже
 * порога `${\"… (N more lines)\"}` и модель их не видела.
 */
export function extractStructuredOffers(html: string): string {
  const lines: string[] = [];
  const scriptRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null && lines.length < MAX_STRUCTURED_OFFERS) {
    let data: unknown;
    try {
      data = JSON.parse(match[1]);
    } catch {
      continue; // битый JSON-LD — не повод ронять загрузку страницы
    }
    const root = asRecord(data);
    if (!root) continue;
    const graph = Array.isArray(root["@graph"]) ? root["@graph"] : [data];
    for (const node of graph) {
      const rec = asRecord(node);
      if (!rec) continue;
      let offers: unknown[] = [];
      if (rec["@type"] === "OfferCatalog" && Array.isArray(rec.itemListElement)) {
        offers = rec.itemListElement.map((entry) => asRecord(entry)?.item ?? entry);
      } else if (Array.isArray(rec.offers)) {
        offers = rec.offers;
      }
      for (const offer of offers) {
        const o = asRecord(offer);
        if (!o || o["@type"] !== "Offer" || typeof o.name !== "string") continue;
        const price = o.price === undefined ? "" : `${String(o.price)} ${String(o.priceCurrency ?? "")}`.trim();
        const description =
          typeof o.description === "string"
            ? o.description.replace(/\s+/g, " ").trim().slice(0, MAX_OFFER_DESCRIPTION)
            : "";
        lines.push(`- ${o.name}${price ? ` | ${price}` : ""}${description ? ` | ${description}` : ""}`);
        if (lines.length >= MAX_STRUCTURED_OFFERS) break;
      }
    }
  }
  return lines.join("\n");
}

/** Добавляет структурированные офферы в начало текста, который увидит модель. */
function withStructuredOffers(html: string, text: string): string {
  const offers = extractStructuredOffers(html);
  return offers
    ? `STRUCTURED PAGE DATA (JSON-LD offers):\n${offers}\n\n${text}`
    : text;
}

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
    const shell = looksLikeShell(html, bestText);
    return { text: withStructuredOffers(html, bestText), shell, source: "main" };
  }

  const bodyM = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const whole = htmlToText(bodyM ? bodyM[1] : html);
  const shell = looksLikeShell(html, whole);
  return {
    text: withStructuredOffers(html, whole),
    shell,
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
