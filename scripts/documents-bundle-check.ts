// W0 spike: verifies the documents deps are inlined into the bundle and the artifact
// boots WITHOUT `node_modules` (inline, not a runtime resolve). Runs the built
// `bun build` artifact from a clean temp dir (see docs/specs/...documents-module-design.md §4.6).
import { XMLParser } from "fast-xml-parser";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { WorkerMessageHandler } from "pdfjs-dist/legacy/build/pdf.worker.mjs";

// Inline the fake-worker into the artifact: pdfjs otherwise dynamically imports
// `pdf.worker.mjs` next to the bundle. The `globalThis.pdfjsWorker` hook makes it take
// WorkerMessageHandler from the already-inlined module (see PDFWorker.#mainThreadWorkerMessageHandler).
(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = { WorkerMessageHandler };

// --- fast-xml-parser ---------------------------------------------------------
const parser = new XMLParser();
const out = parser.parse("<r><a>1</a></r>");
if (out?.r?.a !== 1 && out?.r?.a !== "1") throw new Error("xml parser bundled incorrectly");
process.stdout.write("fast-xml-parser bundle OK\n");

// --- pdfjs-dist (legacy build, text layer, no canvas) ------------------------
/** Builds a minimal valid 1-page PDF with the text "Hello". */
function helloPdf(): Uint8Array {
  const text = "BT /F1 24 Tf 72 100 Td (Hello) Tj ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

const doc = await getDocument({ data: helloPdf() }).promise;
const page = await doc.getPage(1);
const content = await page.getTextContent();
const text = content.items.map((it: unknown) => (it as { str?: string }).str ?? "").join("");
if (!text.includes("Hello")) throw new Error(`pdf text extraction failed: ${JSON.stringify(text)}`);
process.stdout.write(`pdfjs-dist bundle OK: ${JSON.stringify(text)}\n`);
process.stdout.write("documents deps bundle OK\n");
