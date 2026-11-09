// Rebuilds spreadsheet rows from a PDF that was exported from Excel or Google
// Sheets (text PDFs, not scanned photos). Text pieces are grouped into lines
// by their vertical position, then placed into columns using the x-positions
// of the heading row ("Item | Cost Price | Quantity | Amount").
import { FIELDS, IGNORED_HEADINGS, guessMapping, type Cell } from "./sheet-parse";

const HEADING_WORDS = [...FIELDS.flatMap((f) => f.aliases as readonly string[]), ...IGNORED_HEADINGS].sort((a, b) => b.length - a.length);

/** Some PDFs join neighbouring headings into one text piece ("Cost Price Quantity").
 *  Split it back into known headings, estimating each one's x-position. */
function splitHeading(p: Piece): Piece[] {
  const text = p.str;
  const lower = text.toLowerCase();
  const parts: { s: string; at: number }[] = [];
  let i = 0;
  while (i < lower.length) {
    if (lower[i] === " ") { i++; continue; }
    const hit = HEADING_WORDS.find((w) => lower.startsWith(w, i) && (i + w.length === lower.length || lower[i + w.length] === " "));
    if (!hit) return [p];                     // not made only of headings: leave as is
    parts.push({ s: text.slice(i, i + hit.length), at: i });
    i += hit.length;
  }
  if (parts.length < 2) return [p];
  const perChar = (p.x1 - p.x0) / Math.max(1, text.length);
  return parts.map((pt) => ({ ...p, str: pt.s, x0: p.x0 + pt.at * perChar, x1: p.x0 + (pt.at + pt.s.length) * perChar }));
}

interface Piece { str: string; x0: number; x1: number; y: number; h: number; page: number }
// Minimal shape of a pdf.js document, so this works with the browser and Node builds.
interface PdfDoc { numPages: number; getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }> }

const isNum = (s: string) => /^-?[\d\s,.]+(fcfa|xaf|cfa)?$/i.test(s.trim()) && /\d/.test(s);

export async function pdfRows(doc: PdfDoc): Promise<{ rows: Cell[][]; pages: number; found: boolean }> {
  const lines: Piece[][] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const pieces: Piece[] = [];
    for (const it of content.items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
      const str = (it.str || "").replace(/\s+/g, " ");
      if (!str.trim() || !it.transform) continue;
      const x0 = it.transform[4], y = it.transform[5], h = Math.abs(it.height || it.transform[3] || 8);
      pieces.push({ str, x0, x1: x0 + (it.width || str.length * h * 0.5), y, h, page: p });
    }
    // group into lines (top to bottom), tolerance = half a line height
    pieces.sort((a, b) => b.y - a.y || a.x0 - b.x0);
    const pageLines: Piece[][] = [];
    for (const pc of pieces) {
      const line = pageLines.find((l) => Math.abs(l[0].y - pc.y) <= Math.max(2, pc.h * 0.5));
      if (line) line.push(pc); else pageLines.push([pc]);
    }
    for (const l of pageLines) {
      l.sort((a, b) => a.x0 - b.x0);
      // merge pieces of the same cell (tiny gaps)
      const merged: Piece[] = [];
      for (const pc of l) {
        const last = merged[merged.length - 1];
        if (last && pc.x0 - last.x1 < Math.max(1.5, pc.h * 0.25) && !(isNum(pc.str) && isNum(last.str))) {
          last.str = (last.str + (pc.x0 - last.x1 > pc.h * 0.1 ? " " : "") + pc.str).replace(/\s+/g, " ");
          last.x1 = pc.x1;
        } else merged.push({ ...pc });
      }
      lines.push(merged.map((m) => ({ ...m, str: m.str.trim() })).filter((m) => m.str));
    }
  }

  // the heading row gives the column positions
  const hIdx = lines.findIndex((l) => { const m = guessMapping(l.flatMap(splitHeading).map((p) => p.str)); return m.name !== undefined && Object.keys(m).length >= 2; });
  if (hIdx < 0) return { rows: lines.map((l) => l.map((p) => p.str)), pages: doc.numPages, found: false };
  const header = lines[hIdx].flatMap(splitHeading);
  // column i spans from (just before) its heading's left edge to the next heading's left edge
  const starts = header.map((p, i) => (i === 0 ? -Infinity : p.x0 - Math.min(8, (p.x0 - header[i - 1].x1) / 2)));

  const place = (mode: "right" | "center"): string[][] => lines.map((l, li) => {
    if (li === hIdx) return header.map((p) => p.str);
    const filled = l.filter((p) => p.str);
    // a lone text piece = a heading/category row ("PHONE CHARGERS"), keep it in the first cell
    if (filled.length === 1 && !isNum(filled[0].str)) return [filled[0].str];
    const cells: string[] = header.map(() => "");
    for (const p of l) {
      const center = (p.x0 + p.x1) / 2;
      // numbers are often right-aligned; text is judged by its middle
      const ref = isNum(p.str) && mode === "right" ? p.x1 - 1 : center;
      let col = 0;
      for (let c = starts.length - 1; c >= 0; c--) if (ref >= starts[c]) { col = c; break; }
      // text never belongs to a number column: it's part of the name
      if (!isNum(p.str) && col > 0 && /cost|price|qty|quant|amount|stock/i.test(header[col].str)) col = 0;
      cells[col] = cells[col] ? `${cells[col]} ${p.str}` : p.str;
    }
    return cells;
  });

  // Self-check: with an Amount column, the right layout makes cost × quantity = amount.
  const hdr = header.map((p) => p.str.toLowerCase());
  const ci = hdr.findIndex((h) => /cost/.test(h)), qi = hdr.findIndex((h) => /quant|qty/.test(h)), ai = hdr.findIndex((h) => /amount|total|value/.test(h));
  const num = (v?: string) => Number(String(v ?? "").replace(/[\s,]|fcfa|xaf|cfa/gi, ""));
  const score = (rs: string[][]) => (ci < 0 || qi < 0 || ai < 0) ? 0
    : rs.filter((r) => r.length > ai && r[ci] && r[qi] && r[ai] && !/\s/.test(r[qi]) && num(r[ci]) * num(r[qi]) === num(r[ai])).length
      - rs.filter((r) => r.some((c) => /^\d[\d,.]*\s+\d/.test(c))).length;   // two numbers stuck in one cell = wrong
  const byRight = place("right"), byCenter = place("center");
  const rows: Cell[][] = score(byCenter) > score(byRight) ? byCenter : byRight;
  return { rows, pages: doc.numPages, found: true };
}

/** Browser: read a PDF File with pdf.js. */
export async function readPdfFile(file: File) {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs"; // copied into /public at install/build
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  return pdfRows(doc as unknown as PdfDoc);
}
