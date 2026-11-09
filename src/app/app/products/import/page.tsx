"use client";
import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import Papa from "papaparse";
import { ChevronLeft, FileSpreadsheet, Download, CircleCheck } from "lucide-react";
import { useBiz } from "@/components/biz";
import { useToast } from "@/components/toast";
import { Alert, Badge, Button, Card, Field, PageHeader, Select } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { fmtMoney, toMinor } from "@/lib/money";
import { cx, downloadCsv, errorMessage } from "@/lib/format";
import { FIELDS, IGNORED_HEADINGS, guessMapping, parseSheets, toImportRows, type Cell, type FieldKey, type Mapping, type Parsed } from "@/lib/sheet-parse";

type Mode = "skip" | "update" | "add_stock";
interface Result { inserted: number; updated: number; stock_added: number; skipped: number }

function ImportInner() {
  const biz = useBiz();
  const toast = useToast();
  const stockMode = useSearchParams().get("mode") === "stock";
  const manageable = biz.sections.filter((s) => s.active && biz.canManage(s.id));
  const [file, setFile] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [map, setMap] = useState<Mapping>({});
  const [section, setSection] = useState(manageable[0]?.id || "");
  const [mode, setMode] = useState<Mode>(stockMode ? "add_stock" : "skip");
  const [addCat, setAddCat] = useState(true);
  const [serverErrors, setServerErrors] = useState<{ row: number; message: string }[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cur = biz.business.currency;

  async function onFile(f: File) {
    setErr(null); setResult(null); setServerErrors([]);
    try {
      let sheets: { name: string; rows: Cell[][] }[] = [];
      if (/\.xlsx$/i.test(f.name)) {
        const readXlsxFile = (await import("read-excel-file/browser")).default;
        const all = await readXlsxFile(f);
        sheets = all.map((s) => ({ name: s.sheet, rows: s.data as Cell[][] }));
      } else if (/\.(csv|txt)$/i.test(f.name)) {
        sheets = [{ name: f.name, rows: Papa.parse<string[]>(await f.text(), { skipEmptyLines: false }).data }];
      } else {
        setErr("Choose an .xlsx or .csv file. In Google Sheets: File → Download → Microsoft Excel (.xlsx). Old .xls files: open in Excel and 'Save as' .xlsx.");
        return;
      }
      const p = parseSheets(sheets);
      if (!p.rows.length) { setErr("No product rows found. The file needs a heading row with a column like 'Item' or 'Name'."); return; }
      setFile(f.name);
      setParsed(p);
      setMap(guessMapping(p.header));
    } catch (e) { setErr(`Could not read the file: ${errorMessage(e)}`); }
  }

  const rows = useMemo(() => (parsed ? toImportRows(parsed, map, { addCategoryToNames: addCat && (parsed.categories.length > 0 || map.category !== undefined) }) : []), [parsed, map, addCat]);
  const renamedCount = rows.filter((r) => r.name !== r.source_name && !r._note).length;
  const sectionNames = manageable.map((s) => s.name.toLowerCase());

  const clientErrors = useMemo(() => {
    const seen = new Set<string>();
    return rows.map((o) => {
      const errs: string[] = [];
      if (!o.name) errs.push("Name missing");
      if (o.section) { if (!sectionNames.includes(o.section.toLowerCase())) errs.push(`Unknown section "${o.section}"`); }
      else if (!section) errs.push("Choose a section");
      const t = o.target_price ? toMinor(o.target_price) : null;
      const m = o.min_price ? toMinor(o.min_price) : t;
      if (t !== null && !(t > 0)) errs.push("Target price must be a number above 0");
      if (t === null && o.min_price) errs.push("Minimum price given without target price");
      if (t !== null && (m === null || !(m > 0) || m > t)) errs.push("Minimum must be between 1 and target");
      if (o.opening_stock && !/^\d+(\.0+)?$/.test(o.opening_stock)) errs.push("Quantity must be a whole number");
      if (o.unit_cost && Number.isNaN(toMinor(o.unit_cost))) errs.push("Cost must be a number");
      const k = o.sku ? `sku:${o.sku.toLowerCase()}` : `name:${o.name.toLowerCase()}|${o.variant_label.toLowerCase()}`;
      if (seen.has(k)) errs.push("Appears twice in the file");
      seen.add(k);
      return errs;
    });
  }, [rows, sectionNames, section]);

  const badRows = clientErrors.filter((e) => e.length).length;
  const totals = useMemo(() => ({
    qty: rows.reduce((a, r) => a + (Number(r.opening_stock) || 0), 0),
    value: rows.reduce((a, r) => a + toMinor(r.unit_cost || 0) * (Number(r.opening_stock) || 0), 0),
    noCost: rows.filter((r) => !r.unit_cost).length,
    noPrice: rows.filter((r) => !r.target_price).length,
    stockNoCost: rows.filter((r) => !r.unit_cost && Number(r.opening_stock) > 0).length,
    notes: rows.filter((r) => r._note).length,
    byCat: rows.reduce<Record<string, number>>((a, r) => { const c = r.category || "No category"; a[c] = (a[c] || 0) + 1; return a; }, {}),
  }), [rows]);

  async function commit() {
    setBusy(true); setErr(null); setServerErrors([]);
    const payload = rows.map(({ _note, source_name, ...o }) => { void _note; void source_name; return biz.costsAnywhere ? o : { ...o, unit_cost: "" }; });
    const { data, error } = await supabase().rpc("import_products", { p_business: biz.business.id, p_rows: payload, p_mode: mode, p_default_section: section || null });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    const res = data as { ok: boolean; errors?: { row: number; message: string }[] } & Result;
    if (!res.ok) { setServerErrors(res.errors || []); return; }
    setResult(res);
    toast("Import complete");
  }

  function template() {
    downloadCsv("products-template.csv", [
      ["Item", "Category", "Cost Price", "Quantity", "Target price", "Min price", "Brand", "SKU"],
      ["Oraimo 2A android charger", "Phone chargers", "1500", "10", "2500", "2000", "Oraimo", ""],
      ["Iphone USB cable", "Cable", "400", "14", "", "", "", ""],
    ]);
  }

  if (result) {
    return (
      <div className="mx-auto max-w-lg space-y-4 pt-6 text-center">
        <CircleCheck className="mx-auto size-14 text-emerald-600" />
        <h1 className="text-2xl font-bold">Import complete</h1>
        <p className="text-slate-600">
          {result.inserted} new product{result.inserted === 1 ? "" : "s"} added
          {result.stock_added ? ` · stock added to ${result.stock_added}` : ""}
          {result.updated ? ` · ${result.updated} updated` : ""}
          {result.skipped ? (mode === "add_stock" ? ` · ${result.skipped} already existed with quantity 0 in the file (unchanged)` : ` · ${result.skipped} already existed (unchanged)`) : ""}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {totals.noPrice > 0 && <Link href="/app/products?filter=needs_price"><Button>Set selling prices</Button></Link>}
          <Link href="/app/products?filter=no_photo"><Button variant="secondary">Add photos</Button></Link>
          <Link href="/app/inventory"><Button variant="secondary">View inventory</Button></Link>
        </div>
        {totals.noPrice > 0 && <p className="text-sm text-slate-500">Products without a selling price stay off the POS until you set one.</p>}
      </div>
    );
  }

  const headerCols = parsed?.header || [];

  return (
    <div className="space-y-4">
      <Link href={stockMode ? "/app/inventory" : "/app/products"} className="inline-flex items-center gap-1 text-sm font-medium text-slate-600"><ChevronLeft className="size-4" /> {stockMode ? "Inventory" : "Products"}</Link>
      <PageHeader title={stockMode ? "Import stock" : "Import products"}
        subtitle={stockMode ? "Upload your stock sheet: new items are created, existing items get the quantity added. Nothing is saved until you confirm." : "From Excel (.xlsx) or CSV, e.g. your inventory Google Sheet. Nothing is saved until you confirm."}
        actions={<Button variant="secondary" onClick={template}><Download className="size-4" /> Template</Button>} />

      <Card className="p-4">
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 p-8 text-center hover:border-brand hover:bg-brand-50">
          <FileSpreadsheet className="size-10 text-brand" />
          <span className="font-semibold">{file || "Choose a file"}</span>
          <span className="text-sm text-slate-500">{parsed ? `${rows.length} products found · tap to choose another` : "Google Sheets: File → Download → Microsoft Excel (.xlsx)"}</span>
          <input type="file" accept=".xlsx,.csv,.txt" className="sr-only" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        </label>
        {err && <Alert tone="danger" className="mt-3">{err}</Alert>}
        {!parsed && <p className="mt-3 text-xs text-slate-500">Title rows, category headings (e.g. PHONE CHARGERS, CABLE), Total rows and an Amount column are recognised and skipped automatically. Selling prices are optional: you can set them after importing.</p>}
      </Card>

      {parsed && (
        <>
          {parsed.skipped.map((sk) => (
            <Alert key={sk.heading} tone="info" title={`Skipped "${sk.heading}" (${sk.rows} rows)`}>These look like shop expenses, not products. Record them under <Link className="font-semibold underline" href="/app/expenses">Expenses</Link> so they count in your net profit.</Alert>
          ))}
          <Card className="space-y-3 p-4">
            <h2 className="font-semibold">1. Where should these products go?</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Section" hint={map.section !== undefined ? "Used for rows without a section" : "All products in this file go to this section"}>
                <Select value={section} onChange={(e) => setSection(e.target.value)}>
                  {manageable.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </Field>
              {(parsed.categories.length > 0 || map.category !== undefined) && (
                <label className="flex items-start gap-2 rounded-xl border border-slate-200 p-3 text-sm sm:col-span-2">
                  <input type="checkbox" className="mt-0.5 size-4 accent-brand" checked={addCat} onChange={(e) => setAddCat(e.target.checked)} />
                  <span><b>Add the category to names that need it</b> (recommended): &quot;2GB&quot; under USB KEY becomes &quot;USB Key 2GB&quot;, &quot;P9&quot; under BLUETOOTH HEADSET becomes &quot;Bluetooth Headset P9&quot;. Clear names like &quot;Iphone USB cable&quot; stay as they are.{addCat && renamedCount ? ` ${renamedCount} names will get their category.` : ""}</span>
                </label>
              )}
              <Field label="If a product already exists (same name or SKU)">
                <Select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
                  <option value="add_stock">Add the quantity to its stock (new stock arrived)</option>
                  <option value="skip">Leave it unchanged</option>
                  <option value="update">Update its cost, prices and details</option>
                </Select>
              </Field>
            </div>
          </Card>

          <Card className="p-4">
            <h2 className="mb-1 font-semibold">2. Check the columns</h2>
            <p className="mb-3 text-sm text-slate-500">We matched your headings automatically{parsed.categories.length ? ` and found ${parsed.categories.length} categories (${parsed.categories.join(", ")})` : ""}. Change any that are wrong.</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {FIELDS.filter((f) => f.key !== "unit_cost" || biz.costsAnywhere).map((f) => (
                <Field key={f.key} label={`${f.label}${"required" in f && f.required ? " *" : ""}`}>
                  <Select value={map[f.key as FieldKey] ?? ""} onChange={(e) => setMap({ ...map, [f.key]: e.target.value === "" ? undefined : Number(e.target.value) })}>
                    <option value="">{f.key === "category" && parsed.categories.length ? "— from the sheet's headings —" : "— not in file —"}</option>
                    {headerCols.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                  </Select>
                </Field>
              ))}
            </div>
            {headerCols.some((h) => IGNORED_HEADINGS.includes(h.toLowerCase())) && <p className="mt-3 text-xs text-slate-500">Columns like “Amount” are totals and are ignored: the app calculates stock value itself.</p>}
          </Card>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
              <h2 className="font-semibold">3. Preview</h2>
              {badRows ? <Badge tone="danger">{badRows} row{badRows > 1 ? "s" : ""} with problems</Badge> : <Badge tone="success">All {rows.length} rows look good</Badge>}
            </div>
            <div className="grid grid-cols-2 gap-3 border-b border-slate-100 p-4 text-sm sm:grid-cols-4">
              <div><p className="text-xs text-slate-500">Products</p><p className="font-semibold">{rows.length}</p><p className="text-xs text-slate-500">{Object.entries(totals.byCat).map(([c, n]) => `${c} ${n}`).join(" · ")}</p></div>
              <div><p className="text-xs text-slate-500">Total quantity</p><p className="tabular font-semibold">{totals.qty}</p></div>
              {biz.costsAnywhere && <div><p className="text-xs text-slate-500">Stock value at cost</p><p className="tabular font-semibold">{fmtMoney(totals.value / 100, cur)}</p><p className="text-xs text-slate-500">{totals.noCost} without cost</p></div>}
              <div><p className="text-xs text-slate-500">Without selling price</p><p className="font-semibold">{totals.noPrice}</p><p className="text-xs text-slate-500">set after import</p></div>
            </div>
            {(totals.stockNoCost > 0 || totals.notes > 0) && (
              <div className="space-y-1 border-b border-slate-100 px-4 py-3 text-sm text-amber-900">
                {biz.costsAnywhere && totals.stockNoCost > 0 && <p>⚠ {totals.stockNoCost} product{totals.stockNoCost > 1 ? "s have" : " has"} stock but no cost price, so profit on {totals.stockNoCost > 1 ? "them" : "it"} can&apos;t be calculated. You can add the cost later.</p>}
                {totals.notes > 0 && <p>⚠ {totals.notes} product{totals.notes > 1 ? "s have" : " has"} the same name as another row and will be numbered, e.g. &quot;… (2)&quot;. See the rows marked below.</p>}
              </div>
            )}
            <div className="max-h-[440px] overflow-auto">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500">
                  <tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Category</th>{biz.costsAnywhere && <th className="px-3 py-2 text-right">Cost</th>}<th className="px-3 py-2 text-right">Qty</th><th className="px-3 py-2 text-right">Price</th><th className="px-3 py-2">Status</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((o, i) => {
                    const se = serverErrors.find((x) => x.row === i + 1);
                    const errs = [...clientErrors[i], ...(se ? [se.message] : [])];
                    return (
                      <tr key={i} className={cx(errs.length > 0 && "bg-red-50")}>
                        <td className="px-3 py-2">{o.name}{o.variant_label ? ` (${o.variant_label})` : ""}
                          {o.name !== o.source_name && !o._note && <span className="block text-xs text-slate-500">in sheet: {o.source_name}</span>}
                          {o._note && <span className="block text-xs font-medium text-amber-800">{o._note}</span>}
                          <span className="block text-xs text-slate-500">{[o.brand, o.sku].filter(Boolean).join(" · ")}</span></td>
                        <td className="px-3 py-2 text-slate-600">{o.category}</td>
                        {biz.costsAnywhere && <td className="tabular whitespace-nowrap px-3 py-2 text-right">{o.unit_cost ? fmtMoney(o.unit_cost, cur) : <span className="text-slate-400">—</span>}</td>}
                        <td className="tabular px-3 py-2 text-right">{o.opening_stock || 0}</td>
                        <td className="tabular whitespace-nowrap px-3 py-2 text-right">{o.target_price ? fmtMoney(o.target_price, cur) : <span className="text-xs text-amber-700">later</span>}</td>
                        <td className="px-3 py-2">{errs.length ? <span className="text-xs font-medium text-red-700">{errs.join("; ")}</span> : <span className="text-xs text-emerald-700">OK</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="space-y-3 p-4">
            {serverErrors.length > 0 && <Alert tone="danger" title="Nothing was imported">Fix the rows marked in red in your file, then upload it again.</Alert>}
            {map.name === undefined && <Alert tone="warning">Choose which column holds the product name.</Alert>}
            <Button size="lg" block disabled={map.name === undefined || badRows > 0 || !rows.length} loading={busy} onClick={commit}>
              Import {rows.length} product{rows.length === 1 ? "" : "s"}
            </Button>
            <p className="text-xs text-slate-500">All-or-nothing: if any row fails, nothing is saved. Quantities are recorded in the stock history.</p>
          </Card>
        </>
      )}
    </div>
  );
}

export default function ImportPage() {
  return <Suspense><ImportInner /></Suspense>;
}
