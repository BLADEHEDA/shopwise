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
  { key: "opening_stock", label: "Quantity", aliases: ["opening_stock", "quantity", "qty", "stock", "opening stock", "in stock", "quantité", "qte"] },
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
export interface ParsedRow { sheet: string; line: number; cells: string[]; category: string }
export interface Parsed { header: string[]; rows: ParsedRow[]; headerLine: number; categories: string[] }

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

/** A single text cell in capitals (no long numbers/dates), e.g. "PHONE CHARGERS". */
function categoryOf(cells: string[]): string | null {
  const filled = cells.filter(Boolean);
  if (filled.length !== 1) return null;
  const t = filled[0];
  return !/\d{3,}/.test(t) && t === t.toUpperCase() && /[A-Z]/.test(t) ? titleCase(t) : null;
}

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
    // a category heading just above the column headings applies to the first block
    for (let j = h - 1; j >= 0; j--) {
      const c = categoryOf(data[j]);
      if (c) { category = c; categories.add(c); break; }
    }

    for (let i = h + 1; i < data.length; i++) {
      const cells = data[i];
      const filled = cells.filter(Boolean);
      if (!filled.length) continue;
      if (isHeaderRow(cells)) continue;                                   // repeated headings
      if (cells.some((c) => /^(grand\s*|sub\s*)?total\s*:?$/i.test(c))) continue; // total rows
      const cat = categoryOf(cells);                                      // category heading row
      if (cat) { category = cat; categories.add(cat); continue; }
      if (!cells[nameCol]) continue;                                      // numbers without a name
      rows.push({ sheet: sheet.name, line: i + 1, cells, category });
    }
  }
  return { header, rows, headerLine, categories: Array.from(categories) };
}

export function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s(/-])([a-zà-ÿ])/g, (_, a, b) => a + b.toUpperCase());
}

export function inferBrand(name: string): string {
  const first = name.trim().split(/\s+/)[0]?.toLowerCase();
  return KNOWN_BRANDS.find((b) => b.toLowerCase() === first) || "";
}

/** Builds the rows sent to the database from the parsed sheet + column mapping. */
export function toImportRows(parsed: Parsed, map: Mapping): Record<string, string>[] {
  return parsed.rows.map((r) => {
    const o: Record<string, string> = {};
    for (const f of FIELDS) {
      const i = map[f.key];
      o[f.key] = i === undefined ? "" : r.cells[i] ?? "";
    }
    for (const k of ["unit_cost", "opening_stock", "target_price", "min_price", "low_stock_threshold"]) o[k] = cleanNumber(o[k]);
    if (!o.category) o.category = r.category;
    if (!o.brand) o.brand = inferBrand(o.name);
    return o;
  });
}
