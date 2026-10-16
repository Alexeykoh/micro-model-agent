/**
 * Детерминированные минимальные PDF-фикстуры (не под `src/`).
 *
 * Собирает валидный PDF: `%PDF-1.4`, объекты (Catalog/Pages/Page/Content/Font),
 * таблицу `xref`, `trailer` и `%%EOF`. Текст страницы — один оператор `Tj`;
 * пустой content stream даёт страницу без текстового слоя (скан-подобный
 * документ). Смещения `xref` считаются в байтах (UTF-8), поэтому фикстуры
 * корректны и для не-ASCII текста. Используется тестами обработчика PDF (W3).
 */

/** Одна страница фикстуры: текст (пусто/`undefined` → нет текстового слоя). */
export interface PdfPageSpec {
  text?: string;
}

/** Экранирует спецсимволы PDF-строки (`\`, `(`, `)`). */
function escapePdfText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Content stream страницы: `BT … Tj ET` с текстом, либо пустой поток. */
function contentStream(text: string | undefined): string {
  if (!text) return "";
  return `BT /F1 24 Tf 72 100 Td (${escapePdfText(text)}) Tj ET`;
}

/**
 * Собирает валидный PDF с заданными страницами (пустой список → одна страница).
 *
 * Нумерация объектов: `1` — Catalog, `2` — Pages, далее на каждую страницу пара
 * (Page, Content), последний объект — общий Font `/F1`.
 */
export function buildPdf(pages: PdfPageSpec[]): Uint8Array {
  const specs = pages.length > 0 ? pages : [{}];
  const n = specs.length;
  const fontObj = 3 + n * 2; // 3,4 → стр.1; 5,6 → стр.2; …
  const objs: string[] = [];
  const kidRefs: string[] = [];
  for (let i = 0; i < n; i++) kidRefs.push(`${3 + i * 2} 0 R`);
  objs[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[1] = `<< /Type /Pages /Kids [${kidRefs.join(" ")}] /Count ${n} >>`;
  for (let i = 0; i < n; i++) {
    const pageObj = 3 + i * 2;
    const stream = contentStream(specs[i].text);
    objs[pageObj - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] ` +
      `/Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${pageObj + 1} 0 R >>`;
    objs[pageObj] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  objs[fontObj - 1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let len = 0;
  const emit = (s: string): void => {
    const b = enc.encode(s);
    chunks.push(b);
    len += b.length;
  };
  emit("%PDF-1.4\n");
  const offsets: number[] = [];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(len);
    emit(`${i + 1} 0 obj\n${objs[i]}\nendobj\n`);
  }
  const xref = len;
  emit(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`);
  for (const off of offsets) emit(`${String(off).padStart(10, "0")} 00000 n \n`);
  emit(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);

  const out = new Uint8Array(len);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

/** 1 страница с текстом "Hello". */
export function helloPdf(): Uint8Array {
  return buildPdf([{ text: "Hello" }]);
}

/** 1 страница с пустым content stream — нет текстового слоя (скан-подобный). */
export function noTextPdf(): Uint8Array {
  return buildPdf([{}]);
}

/** N страниц с заданным текстом (страница i — `texts[i]`). */
export function multiPagePdf(texts: string[]): Uint8Array {
  return buildPdf(texts.map((text) => ({ text })));
}
