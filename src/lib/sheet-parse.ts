// Turns a real-world inventory spreadsheet into product rows.
// Handles sheets like Frankonic's Google Sheet:
//   - a title row above the headings ("FRANCONICS STORE INVENTORY 08/01/2025")
//   - category heading rows in capitals ("PHONE CHARGERS", "CABLE")
//   - "Total" rows, blank rows, rows with numbers but no name
//   - repeated heading rows, several tabs in one file
//   - number cells written as "1,500", "1500 FCFA" or real numbers

export const FIELDS = [
  { key: "name", label: "Product name", required: true, aliases: ["name", "item", "items", "item name", "product", "product name", "article", "designation", "désignation"] },
  { key: "unit_cost", label: "Cost price (owner only)", aliases: ["unit_cost", "cost", "cost price", "unit cost", "buying price", "purchase price", "landed cost", "cp", "prix d'achat"] },
  { key: "opening_stock", label: "Quantity", aliases: ["opening_stock", "quantity", "qty", "stock", "opening stock", "in stock", "quantité", "qte", "qté", "quantite"] },
  { key: "target_price", label: "Target selling price", aliases: ["target_price", "target price", "selling price", "sale price", "retail price", "price", "sp", "prix de vente"] },
  { key: "min_price", label: "Minimum selling price", aliases: ["min_price", "minimum price", "min price", "minimum selling price", "floor price", "lowest price"] },
  { key: "category", label: "Category", aliases: ["category", "type", "group", "catégorie"] },
  { key: "section", label: "Section", aliases: ["section", "department", "unit", "rayon"] },
  { key: "brand", label: "Brand", aliases: ["brand", "make", "marque"] },
  { key: "model", label: "Model", aliases: ["model", "modèle"] },
  { key: "variant_label", label: "Variant", aliases: ["variant", "variant_label", "size", "colour", "color"] },
  { key: "sku", label: "SKU / code", aliases: ["sku", "code", "item code", "product code", "barcode", "ref", "reference"] },
  { key: "low_stock_threshold", label: "Low-stock level", aliases: ["low_stock_threshold", "reorder level", "low stock", "min stock", "alert"] },
  { key: "description", label: "Description", aliases: ["description", "details", "notes"] },
] as const;
export type FieldKey = (typeof FIELDS)[number]["key"];
export type Mapping = Partial<Record<FieldKey, number>>;
export const IGNORED_HEADINGS = ["amount", "total", "value", "montant", "s/n", "no", "#"];

const KNOWN_BRANDS = ["Oraimo", "Samsung", "Apple", "Itel", "Tecno", "Infinix", "JBL", "Xiaomi", "Anker", "Baseus", "HP", "Lenovo", "Dell", "Sony", "Nokia", "Huawei", "Ugreen", "Hoco", "Remax", "QiYi", "Arduino", "Logitech", "SanDisk", "Kingston", "Toshiba"];

export type Cell = string | number | boolean | Date | null | undefined;
export interface SheetIn { name: string; rows: Cell[][] }
export interface ParsedRow { sheet: string; line: number; cells: string[]; category: string; note?: string }
export interface Parsed { header: string[]; rows: ParsedRow[]; headerLine: number; categories: string[]; skipped: { heading: string; rows: number }[] }

const norm = (v: Cell) => (v === null || v === undefined ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v)).replace(/\s+/g, " ").trim();
const key = (v: string) => v.toLowerCase().replace(/[^a-zà-ÿ0-9/#' ]/g, "").trim();

export function guessMapping(header: string[]): Mapping {
  const m: Mapping = {};
  header.forEach((h, i) => {
    const k = key(h);
    if (!k) return;
    const f = FIELDS.find((x) => (x.aliases as readonly string[]).includes(k));
    if (f && m[f.key] === undefined) m[f.key] = i;
  });
  return m;
}

/** A row with a single text cell and nothing else, e.g. "PHONE CHARGERS" or
 *  "Smart Watch". (A product row always has a cost, quantity or amount.) */
function headingOf(cells: string[]): string | null {
  const filled = cells.filter(Boolean);
  if (filled.length !== 1) return null;
  const t = filled[0];
  if (/^-?\d+([.,]\d+)?$/.test(t)) return null;           // a lone number (e.g. an Amount cell)
  if (/inventory|inventaire/i.test(t)) return null;          // the sheet title
  return t;
}
/** Blocks that are not products: "STORE EXPENSES (MAY2025 - APRIL2026)". */
export const isExpenseHeading = (t: string) => /expense|d[ée]pense|charges\b/i.test(t);

function isHeaderRow(cells: string[]): boolean {
  const m = guessMapping(cells);
  return m.name !== undefined && Object.keys(m).length >= 2;
}

/** Number cells: "1,500" / "1 500" / "1500 FCFA" / 1500 → "1500"; text stays text. */
export function cleanNumber(v: string): string {
  const t = v.replace(/\s|,|fcfa|xaf|cfa|frs?\.?$/gi, "");
  return /^-?\d+(\.\d+)?$/.test(t) ? String(Number(t)) : v.trim();
}

export function parseSheets(sheets: SheetIn[]): Parsed {
  let header: string[] = [];
  let headerLine = 0;
  const rows: ParsedRow[] = [];
  const categories = new Set<string>();
  const skipped: { heading: string; rows: number }[] = [];
  const multi = sheets.filter((s) => s.rows.some((r) => r.some((c) => norm(c)))).length > 1;

  for (const sheet of sheets) {
    const data = sheet.rows.map((r) => r.map(norm));
    // 1. find the heading row (first 20 rows); fall back to the first row
    let h = data.slice(0, 20).findIndex(isHeaderRow);
    if (h < 0) h = data.findIndex((r) => r.some(Boolean));
    if (h < 0) continue;
    if (!header.length) { header = data[h]; headerLine = h + 1; }
    const nameCol = guessMapping(data[h]).name ?? 0;
    let category = multi ? sheet.name : "";
    let skipping: { heading: string; rows: number } | null = null;
    // a category heading just above the column headings applies to the first block
    for (let j = h - 1; j >= 0; j--) {
      const c = headingOf(data[j]);
      if (c) { category = smartTitle(c); categories.add(category); break; }
    }

    for (let i = h + 1; i < data.length; i++) {
      const cells = data[i];
      const filled = cells.filter(Boolean);
      if (!filled.length) continue;
      if (isHeaderRow(cells)) continue;                                   // repeated headings
      if (cells.some((c) => /^(grand\s*|sub\s*)?total\s*:?$/i.test(c))) continue; // total rows
      const head = headingOf(cells);                                      // category heading row
      if (head) {
        if (isExpenseHeading(head)) { skipping = { heading: head, rows: 0 }; skipped.push(skipping); continue; }
        skipping = null;
        category = smartTitle(head); categories.add(category);
        continue;
      }
      if (!cells[nameCol]) continue;                                      // numbers without a name
      if (skipping) { skipping.rows++; continue; }                        // e.g. rent, electricity
      rows.push({ sheet: sheet.name, line: i + 1, cells, category });
    }
  }
  return { header, rows, headerLine, categories: Array.from(categories), skipped };
}

export function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s(/-])([a-zà-ÿ])/g, (_, a, b) => a + b.toUpperCase());
}

const ACRONYMS = new Set(["usb", "otg", "hdd", "ssd", "hdmi", "led", "tv", "vga", "dvd", "aux", "sd", "rj45", "ps2", "ps3", "ps4", "mp3", "dvi", "lcd", "pc"]);
const SMALL = new Set(["and", "of", "for", "with", "in", "to", "the", "a"]);
/** "USB KEY" → "USB Key", "PHONE AND SMALL BATTERIES" → "Phone and Small Batteries" */
export function smartTitle(s: string): string {
  return s.trim().split(/(\s+|\/|\(|\)|-)/).map((w, i) => {
    const l = w.toLowerCase();
    if (!/[a-zà-ÿ]/i.test(w)) return w;
    if (ACRONYMS.has(l)) return l.toUpperCase();
    if (i > 0 && SMALL.has(l)) return l;
    return l.charAt(0).toUpperCase() + l.slice(1);
  }).join("");
}

function singular(w: string): string {
  const l = w.toLowerCase();
  if (l.endsWith("ies")) return w.slice(0, -3) + "y";
  if (l.endsWith("ss") || l.length <= 3) return w;
  return l.endsWith("s") ? w.slice(0, -1) : w;
}

/** What to put in front of a product name so it makes sense on its own
 *  (e.g. "2GB" → "USB Key 2GB"), or null if the name is already clear. */
export function categoryPrefix(category: string, name: string): string | null {
  if (!category || /^others?\b/i.test(category)) return null;
  const segments = category.split(/\s*\/\s*|\s*\(/).map((x) => x.replace(/\)/g, "").trim()).filter(Boolean);
  // the "head" noun of each part: Phone Chargers → charger, Earbuds/Airpods → earbud, airpod
  const heads = segments.map((seg) => singular(seg.split(/\s+/).pop() || "").toLowerCase());
  const lname = name.toLowerCase();
  if (heads.some((hd) => hd && new RegExp(`\\b${hd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`, "i").test(lname))) return null;
  const first = segments[0] || category;
  const words = first.split(/\s+/);
  const prefix = words.length > 3 ? singular(words[words.length - 1]) : [...words.slice(0, -1), singular(words[words.length - 1])].join(" ");
  return smartTitle(prefix);
}

export function inferBrand(name: string): string {
  const first = name.trim().split(/\s+/)[0]?.toLowerCase();
  return KNOWN_BRANDS.find((b) => b.toLowerCase() === first) || "";
}

export interface ImportRow extends Record<string, string> { _note: string }

/** Builds the rows sent to the database from the parsed sheet + column mapping.
 *  addCategoryToNames: "2GB" under USB KEY becomes "USB Key 2GB".
 *  Exact duplicate names (e.g. "iPhone" twice under PHONE CASE) are numbered
 *  "(2)" and flagged in _note so they can be renamed later. */
export function toImportRows(parsed: Parsed, map: Mapping, opts: { addCategoryToNames?: boolean } = {}): ImportRow[] {
  const seen = new Map<string, number>();
  return parsed.rows.map((r) => {
    const o = { _note: "" } as ImportRow;
    for (const f of FIELDS) {
      const i = map[f.key];
      o[f.key] = i === undefined ? "" : r.cells[i] ?? "";
    }
    for (const k of ["unit_cost", "opening_stock", "target_price", "min_price", "low_stock_threshold"]) o[k] = cleanNumber(o[k]);
    o.category = o.category ? smartTitle(o.category) : r.category;
    o.source_name = o.name;
    if (opts.addCategoryToNames) {
      const pre = categoryPrefix(o.category, o.name);
      if (pre) o.name = `${pre} ${o.name}`;
    }
    if (!o.brand) o.brand = inferBrand(o.source_name) || inferBrand(o.name.split(" ").slice(-2)[0] || "");
    const key = o.sku ? `sku:${o.sku.toLowerCase()}` : `${o.name.toLowerCase()}|${o.variant_label.toLowerCase()}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n > 1 && !o.sku) {
      o.name = `${o.name} (${n})`;
      o._note = `Same name as an earlier row: imported as "${o.name}". Rename it later if you like.`;
    }
    if (r.note) o._note = o._note ? `${o._note} · ${r.note}` : r.note;
    return o;
  });
}
