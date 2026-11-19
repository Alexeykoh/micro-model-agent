/**
 * Детерминированные минимальные PDF-фикстуры (не под `src/`).
 *
 * Собирает валидный PDF: `%PDF-1.4`, объекты (Catalog/Pages/Page/Content/Font,
 * опционально дерево `/Outlines`), таблицу `xref`, `trailer` и `%%EOF`. Текст
 * страницы — один оператор `Tj`; пустой content stream даёт страницу без
 * текстового слоя (скан-подобный документ). Смещения `xref` считаются в байтах
 * (UTF-8) и точны; `/Length` потока берётся как число символов строки (не байт),
 * поэтому для не-ASCII содержимого `/Length` занижен — фикстуры гарантируют
 * побайтовую точность только для `xref` (ASCII-контент). Используется тестами
 * обработчика PDF (W3).
 */

/** Одна страница фикстуры: текст (пусто/`undefined` → нет текстового слоя). */
export interface PdfPageSpec {
  text?: string;
}

/** Закладка фикстуры: заголовок, целевая страница (1-based), вложенные закладки. */
export interface PdfBookmark {
  title: string;
  page?: number;
  children?: PdfBookmark[];
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
 * Собирает валидный PDF с заданными страницами (пустой список → одна страница)
 * и опциональным деревом закладок.
 *
 * Нумерация объектов: `1` — Catalog, `2` — Pages, далее на каждую страницу пара
 * (Page, Content), затем общий Font `/F1`, затем (если заданы закладки) корень
 * `/Outlines` и узлы дерева закладок.
 */
export function buildPdf(pages: PdfPageSpec[], outline: PdfBookmark[] = []): Uint8Array {
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

  /** Число узлов в поддереве (для `/Count` открытого узла закладок). */
  const countNodes = (list: PdfBookmark[]): number =>
    list.reduce((sum, b) => sum + 1 + countNodes(b.children ?? []), 0);

  if (outline.length > 0) {
    const outlineRoot = fontObj + 1; // корень дерева закладок
    let next = fontObj + 2; // следующий свободный номер объекта
    // Рекурсивно размечает узлы: сначала назначает номера всем сиблингам, затем
    // уходит в детей (нумерация не обязана совпадать с порядком обхода pdfjs).
    const emitNodes = (list: PdfBookmark[], parentNum: number): { first: number; last: number } => {
      const nums = list.map(() => next++);
      list.forEach((b, i) => {
        const parts = [`/Title (${escapePdfText(b.title)})`, `/Parent ${parentNum} 0 R`];
        if (i > 0) parts.push(`/Prev ${nums[i - 1]} 0 R`);
        if (i < list.length - 1) parts.push(`/Next ${nums[i + 1]} 0 R`);
        const kids = b.children ?? [];
        if (kids.length > 0) {
          const child = emitNodes(kids, nums[i]);
          parts.push(`/First ${child.first} 0 R`, `/Last ${child.last} 0 R`, `/Count ${countNodes(kids)}`);
        }
        const pageObj = 3 + ((b.page ?? 1) - 1) * 2;
        parts.push(`/Dest [${pageObj} 0 R /Fit]`);
        objs[nums[i] - 1] = `<< ${parts.join(" ")} >>`;
      });
      return { first: nums[0], last: nums[list.length - 1] };
    };
    const root = emitNodes(outline, outlineRoot);
    objs[outlineRoot - 1] =
      `<< /Type /Outlines /First ${root.first} 0 R /Last ${root.last} 0 R /Count ${countNodes(outline)} >>`;
    objs[0] = `<< /Type /Catalog /Pages 2 0 R /Outlines ${outlineRoot} 0 R /PageMode /UseOutlines >>`;
  }

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

/** 1 страница с текстом и деревом закладок (`Chapter One`, `Chapter Two` → `Sub`). */
export function outlinePdf(): Uint8Array {
  return buildPdf([{ text: "Body text" }], [
    { title: "Chapter One", page: 1 },
    { title: "Chapter Two", page: 1, children: [{ title: "Sub", page: 1 }] },
  ]);
}

/** Битый PDF: есть `%PDF-`-заголовок, но нет `xref`/`trailer` — `parse` обязан бросить. */
export function malformedPdf(): Uint8Array {
  return new TextEncoder().encode("%PDF-1.4\nnot a real pdf body\n");
}
