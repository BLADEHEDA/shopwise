"use client";
import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import Papa from "papaparse";
import { ChevronLeft, FileSpreadsheet, Download, CircleCheck, Sparkles, Trash2, LoaderCircle, Camera, RotateCcw } from "lucide-react";
import { useBiz } from "@/components/biz";
import { useToast } from "@/components/toast";
import { Alert, Badge, Button, Card, Field, PageHeader, Select } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { fmtMoney, toMinor } from "@/lib/money";
import { cx, downloadCsv, errorMessage } from "@/lib/format";
import { FIELDS, IGNORED_HEADINGS, guessMapping, parseSheets, toImportRows, type Cell, type FieldKey, type ImportRow, type Mapping, type Parsed } from "@/lib/sheet-parse";
import { fileKind, readDocx, smartRead, smartToParsed } from "@/lib/smart-import";

type Mode = "skip" | "update" | "add_stock";
type EditKey = "name" | "category" | "unit_cost" | "opening_stock" | "target_price";
interface Result { inserted: number; updated: number; stock_added: number; skipped: number }

function ImportInner() {
  const biz = useBiz();
  const toast = useToast();
  const stockMode = useSearchParams().get("mode") === "stock";
  const manageable = biz.sections.filter((s) => s.active && biz.canManage(s.id));
  const [files, setFiles] = useState<File[]>([]);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [source, setSource] = useState<"reader" | "ai">("reader");
  const [aiInfo, setAiInfo] = useState<{ notes: string | null; currency: string | null; truncated: boolean } | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [map, setMap] = useState<Mapping>({});
  const [section, setSection] = useState(manageable[0]?.id || "");
  const [mode, setMode] = useState<Mode>(stockMode ? "add_stock" : "skip");
  const [addCat, setAddCat] = useState(true);
  const [edits, setEdits] = useState<Record<number, Partial<Record<EditKey, string>>>>({});
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [serverErrors, setServerErrors] = useState<{ row: number; message: string }[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cur = biz.business.currency;

  function show(p: Parsed, src: "reader" | "ai") {
    setParsed(p); setSource(src); setMap(guessMapping(p.header)); setEdits({}); setRemoved(new Set()); setServerErrors([]);
    setAddCat(src === "reader"); // smart reading already writes full names where needed
  }

  async function runAi(list: File[], text?: string) {
    setReading("Reading your file with smart reading… this can take up to a minute for long or handwritten lists.");
    try {
      const r = await smartRead(biz.business.id, { files: text ? [] : list, text, fileName: list.map((f) => f.name).join(", ") });
      show(smartToParsed(r, list[0]?.name || "file"), "ai");
      setAiInfo({ notes: r.notes, currency: r.currency, truncated: r.truncated });
    } catch (e) { setErr(errorMessage(e)); } finally { setReading(null); }
  }

  /** Try the built-in reader first (free, instant); fall back to smart reading. */
  async function onFiles(list: File[]) {
    setErr(null); setResult(null); setAiInfo(null); setParsed(null);
    if (!list.length) return;
    setFiles(list);
    const kinds = list.map(fileKind);
    if (kinds.includes("unknown")) { setErr("Upload Excel (.xlsx), CSV, PDF, Word (.docx) or photos (JPG/PNG)."); return; }
    if (kinds.some((k) => k === "image")) {
      if (kinds.some((k) => k !== "image")) { setErr("Upload photos on their own (you can choose several), or one document."); return; }
      return runAi(list);
    }
    if (list.length > 1) { setErr("Upload one document at a time (several photos are fine)."); return; }
    const f = list[0], kind = kinds[0];
    setReading("Reading your file…");
    try {
      let sheets: { name: string; rows: Cell[][] }[] = [];
      let aiText: string | undefined;
      if (kind === "xlsx") {
        const readXlsxFile = (await import("read-excel-file/browser")).default;
        sheets = (await readXlsxFile(f)).map((s) => ({ name: s.sheet, rows: s.data as Cell[][] }));
      } else if (kind === "csv") {
        sheets = [{ name: f.name, rows: Papa.parse<string[]>(await f.text(), { skipEmptyLines: false }).data }];
      } else if (kind === "docx") {
        const d = await readDocx(f);
        sheets = [{ name: f.name, rows: d.rows }];
        aiText = d.text;
      } else if (kind === "pdf") {
        const { readPdfFile } = await import("@/lib/pdf-table");
        const pdf = await readPdfFile(f);
        if (!pdf.rows.length || !pdf.found) { setReading(null); return runAi([f]); }   // scan or no clear table
        sheets = [{ name: f.name, rows: pdf.rows }];
      }
      const p = parseSheets(sheets);
      const m = guessMapping(p.header);
      const usable = p.rows.length > 0 && m.name !== undefined && (m.unit_cost !== undefined || m.opening_stock !== undefined || m.target_price !== undefined);
      setReading(null);
      if (usable) return show(p, "reader");
      // no recognisable columns: let the AI understand it
      const text = aiText ?? sheets.map((s) => `# ${s.name}\n${Papa.unparse(s.rows.map((r) => r.map((c) => (c == null ? "" : String(c)))))}`).join("\n\n");
      return runAi([f], kind === "pdf" ? undefined : text);
    } catch (e) { setReading(null); setErr(`Could not read the file: ${errorMessage(e)}`); }
  }

  async function aiInstead() {
    const f = files[0];
    if (!f) return;
    setErr(null);
    const kind = fileKind(f);
    if (kind === "pdf" || kind === "image") return runAi(files);
    if (kind === "docx") return runAi([f], (await readDocx(f)).text);
    let rows: Cell[][] = [];
    if (kind === "xlsx") { const r = (await import("read-excel-file/browser")).default; rows = (await r(f)).flatMap((s) => [[`# ${s.sheet}`], ...(s.data as Cell[][])]); }
    else rows = Papa.parse<string[]>(await f.text()).data;
    return runAi([f], Papa.unparse(rows.map((r) => r.map((c) => (c == null ? "" : String(c))))));
  }

  // ---------------------------------------------------------------- rows (with edits)
  const baseRows = useMemo(() => (parsed ? toImportRows(parsed, map, { addCategoryToNames: addCat && (parsed.categories.length > 0 || map.category !== undefined) }) : []), [parsed, map, addCat]);
  const rows = useMemo(() => baseRows.map((r, i) => ({ ...r, ...(edits[i] || {}), _i: i } as ImportRow & { _i: number })).filter((r) => !removed.has(r._i)), [baseRows, edits, removed]);
  const renamedCount = rows.filter((r) => r.name !== r.source_name && !r._note).length;
  const sectionNames = manageable.map((s) => s.name.toLowerCase());
  const setEdit = (i: number, k: EditKey, v: string) => setEdits((e) => ({ ...e, [i]: { ...(e[i] || {}), [k]: v } }));

  const clientErrors = useMemo(() => {
    const seen = new Set<string>();
    return rows.map((o) => {
      const errs: string[] = [];
      if (!o.name.trim()) errs.push("Name missing");
      if (o.section) { if (!sectionNames.includes(o.section.toLowerCase())) errs.push(`Unknown section "${o.section}"`); }
      else if (!section) errs.push("Choose a section");
      const t = o.target_price ? toMinor(o.target_price) : null;
      const m = o.min_price ? toMinor(o.min_price) : t;
      if (t !== null && !(t > 0)) errs.push("Price must be a number above 0");
      if (t === null && o.min_price) errs.push("Minimum price given without target price");
      if (t !== null && (m === null || !(m > 0) || m > t)) errs.push("Minimum must be between 1 and target");
      if (o.opening_stock && !/^\d+(\.0+)?$/.test(o.opening_stock)) errs.push("Quantity must be a whole number");
      if (o.unit_cost && Number.isNaN(toMinor(o.unit_cost))) errs.push("Cost must be a number");
      const k = o.sku ? `sku:${o.sku.toLowerCase()}` : `name:${o.name.trim().toLowerCase()}|${o.variant_label.toLowerCase()}`;
      if (seen.has(k)) errs.push("Same name twice: rename one");
      seen.add(k);
      return errs;
    });
  }, [rows, sectionNames, section]);
  const badRows = clientErrors.filter((e) => e.length).length;

  const lineValue = (r: ImportRow) => (toMinor(r.unit_cost || 0) || 0) * (Number(r.opening_stock) || 0);
  const totals = useMemo(() => ({
    qty: rows.reduce((a, r) => a + (Number(r.opening_stock) || 0), 0),
    value: rows.reduce((a, r) => a + lineValue(r), 0),
    noCost: rows.filter((r) => !r.unit_cost).length,
    noPrice: rows.filter((r) => !r.target_price).length,
    stockNoCost: rows.filter((r) => !r.unit_cost && Number(r.opening_stock) > 0).length,
    notes: rows.filter((r) => r._note).length,
    categories: new Set(rows.map((r) => r.category || "No category")).size,
  }), [rows]);
  const categoryNames = useMemo(() => Array.from(new Set(rows.map((r) => r.category).filter(Boolean))), [rows]);

  async function commit() {
    setBusy(true); setErr(null); setServerErrors([]);
    const payload = rows.map(({ _note, source_name, _i, ...o }) => { void _note; void source_name; void _i; return biz.costsAnywhere ? o : { ...o, unit_cost: "" }; });
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
        <p className="text-sm text-slate-600">Stock value imported: <b>{fmtMoney(totals.value / 100, cur)}</b></p>
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
  // group rows by category for subtotals (keeps the file's order)
  const groups: { category: string; rows: (ImportRow & { _i: number })[]; idx: number[] }[] = [];
  rows.forEach((r, k) => {
    const c = r.category || "No category";
    const g = groups[groups.length - 1];
    if (g && g.category === c) { g.rows.push(r); g.idx.push(k); } else groups.push({ category: c, rows: [r], idx: [k] });
  });

  return (
    <div className="space-y-4">
      <Link href={stockMode ? "/app/inventory" : "/app/products"} className="inline-flex items-center gap-1 text-sm font-medium text-slate-600"><ChevronLeft className="size-4" /> {stockMode ? "Inventory" : "Products"}</Link>
      <PageHeader title={stockMode ? "Import stock" : "Import products"}
        subtitle="Upload your stock list in any form: Excel, CSV, PDF, Word, or photos of a handwritten list. You'll check and correct everything before it's saved."
        actions={<Button variant="secondary" onClick={template}><Download className="size-4" /> Template</Button>} />

      <Card className="p-4">
        <label className={cx("flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 p-8 text-center hover:border-brand hover:bg-brand-50", reading && "pointer-events-none opacity-60")}>
          {reading ? <LoaderCircle className="size-10 animate-spin text-brand" /> : <FileSpreadsheet className="size-10 text-brand" />}
          <span className="font-semibold">{reading ? "Reading…" : files.length ? files.map((f) => f.name).join(", ") : "Choose a file or photos"}</span>
          <span className="text-sm text-slate-500">{reading || (parsed ? `${rows.length} products found · tap to choose another` : "Excel · CSV · PDF · Word · photos (several pages at once is fine)")}</span>
          <input type="file" multiple accept=".xlsx,.csv,.txt,.pdf,.docx,application/pdf,image/*" className="sr-only" onChange={(e) => e.target.files && onFiles(Array.from(e.target.files))} />
        </label>
        <label className={cx("mt-2 flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-slate-300 py-2.5 text-sm font-medium text-slate-700 hover:border-brand sm:hidden", reading && "pointer-events-none opacity-60")}>
          <Camera className="size-4" /> Take a photo of a paper list
          <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => e.target.files && onFiles(Array.from(e.target.files))} />
        </label>
        {err && <Alert tone="danger" className="mt-3">{err}</Alert>}
        {!parsed && !reading && <p className="mt-3 text-xs text-slate-500">Titles, headings, totals and expense lines are recognised and skipped. Selling prices are optional and can be set later. Photos: good light, whole page, held flat.</p>}
      </Card>

      {parsed && (
        <>
          <Alert tone={source === "ai" ? "info" : "success"} title={source === "ai" ? "Read with smart reading (AI)" : "Read directly from your file"}>
            {source === "ai"
              ? <>Please check names and numbers, especially handwritten ones. Rows marked <b>Check</b> were hard to read.{aiInfo?.notes ? ` ${aiInfo.notes}` : ""}{aiInfo?.currency && !/xaf|fcfa|cfa/i.test(aiInfo.currency) ? ` Currency on the list: ${aiInfo.currency}.` : ""}</>
              : <>Columns and categories were recognised automatically. Something looks wrong? <button className="font-semibold underline" onClick={aiInstead}><Sparkles className="inline size-3.5" /> Let smart reading (AI) read it instead</button></>}
          </Alert>
          {aiInfo?.truncated && <Alert tone="warning">The list was very long and may be incomplete. Split it into smaller files and import them one by one.</Alert>}
          {parsed.skipped.map((sk) => (
            <Alert key={sk.heading} tone="info" title={`Skipped ${source === "ai" ? "" : `"${sk.heading}" `}(${sk.rows} line${sk.rows === 1 ? "" : "s"} that aren't products)`}>
              {source === "ai" ? `${sk.heading}. ` : ""}Shop expenses like rent or electricity belong under <Link className="font-semibold underline" href="/app/expenses">Expenses</Link>, so they count in your net profit.
            </Alert>
          ))}

          <Card className="space-y-3 p-4">
            <h2 className="font-semibold">1. Where should these products go?</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Section" hint={map.section !== undefined ? "Used for rows without a section" : "All products in this file go to this section"}>
                <Select value={section} onChange={(e) => setSection(e.target.value)}>
                  {manageable.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </Field>
              <Field label="If a product already exists (same name or SKU)">
                <Select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
                  <option value="add_stock">Add the quantity to its stock (new stock arrived)</option>
                  <option value="skip">Leave it unchanged</option>
                  <option value="update">Update its cost, prices and details</option>
                </Select>
              </Field>
              {(parsed.categories.length > 0 || map.category !== undefined) && (
                <label className="flex items-start gap-2 rounded-xl border border-slate-200 p-3 text-sm sm:col-span-2">
                  <input type="checkbox" className="mt-0.5 size-4 accent-brand" checked={addCat} onChange={(e) => setAddCat(e.target.checked)} />
                  <span><b>Add the category to names that need it</b> (recommended): &quot;2GB&quot; under USB KEY becomes &quot;USB Key 2GB&quot;. Clear names stay as they are.{addCat && renamedCount ? ` ${renamedCount} names will get their category.` : ""}</span>
                </label>
              )}
            </div>
          </Card>

          {source === "reader" && (
            <details className="rounded-2xl border border-slate-200 bg-white p-4">
              <summary className="cursor-pointer font-semibold">2. Columns (matched automatically, tap to check)</summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {FIELDS.filter((f) => f.key !== "unit_cost" || biz.costsAnywhere).map((f) => (
                  <Field key={f.key} label={`${f.label}${"required" in f && f.required ? " *" : ""}`}>
                    <Select value={map[f.key as FieldKey] ?? ""} onChange={(e) => setMap({ ...map, [f.key]: e.target.value === "" ? undefined : Number(e.target.value) })}>
                      <option value="">{f.key === "category" && parsed.categories.length ? "— from the sheet's headings —" : "— not in file —"}</option>
                      {headerCols.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                    </Select>
                  </Field>
                ))}
              </div>
              {headerCols.some((h) => IGNORED_HEADINGS.includes(h.toLowerCase())) && <p className="mt-3 text-xs text-slate-500">Columns like “Amount” are ignored: the app calculates values itself.</p>}
            </details>
          )}

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
              <h2 className="font-semibold">3. Check and correct</h2>
              {badRows ? <Badge tone="danger">{badRows} row{badRows > 1 ? "s" : ""} to fix</Badge> : <Badge tone="success">All {rows.length} rows look good</Badge>}
            </div>
            <div className="grid grid-cols-2 gap-3 border-b border-slate-100 p-4 text-sm sm:grid-cols-4">
              <div><p className="text-xs text-slate-500">Products</p><p className="font-semibold">{rows.length}</p><p className="text-xs text-slate-500">{totals.categories} categor{totals.categories === 1 ? "y" : "ies"}</p></div>
              <div><p className="text-xs text-slate-500">Total quantity</p><p className="tabular font-semibold">{totals.qty}</p></div>
              {biz.costsAnywhere && <div><p className="text-xs text-slate-500">Total value at cost</p><p className="tabular font-semibold">{fmtMoney(totals.value / 100, cur)}</p><p className="text-xs text-slate-500">{totals.noCost} without cost</p></div>}
              <div><p className="text-xs text-slate-500">Without selling price</p><p className="font-semibold">{totals.noPrice}</p><p className="text-xs text-slate-500">set after import</p></div>
            </div>
            {(totals.stockNoCost > 0 || totals.notes > 0) && (
              <div className="space-y-1 border-b border-slate-100 px-4 py-3 text-sm text-amber-900">
                {biz.costsAnywhere && totals.stockNoCost > 0 && <p>⚠ {totals.stockNoCost} product{totals.stockNoCost > 1 ? "s have" : " has"} stock but no cost price: type it in below, or add it later.</p>}
                {totals.notes > 0 && <p>⚠ {totals.notes} row{totals.notes > 1 ? "s" : ""} marked below need a quick check.</p>}
              </div>
            )}
            <p className="px-4 pt-3 text-xs text-slate-500">Tap any cell to correct it. Use the bin to leave a row out.</p>
            <div className="max-h-[60vh] overflow-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="sticky top-0 z-10 bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-2 py-2">Name</th><th className="px-2 py-2">Category</th>
                    {biz.costsAnywhere && <th className="px-2 py-2 text-right">Cost</th>}
                    <th className="px-2 py-2 text-right">Qty</th>
                    {biz.costsAnywhere && <th className="px-2 py-2 text-right">Value</th>}
                    <th className="px-2 py-2 text-right">Sell price</th><th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <GroupRows key={`${g.category}-${g.idx[0]}`} g={g} errorsFor={(k) => [...clientErrors[k], ...(serverErrors.find((x) => x.row === k + 1) ? [serverErrors.find((x) => x.row === k + 1)!.message] : [])]}
                      costs={biz.costsAnywhere} cur={cur} lineValue={lineValue} setEdit={setEdit} remove={(i) => setRemoved((s) => new Set(s).add(i))} />
                  ))}
                  <tr className="sticky bottom-0 bg-slate-100 font-semibold">
                    <td className="px-2 py-2" colSpan={2}>Grand total · {rows.length} products</td>
                    {biz.costsAnywhere && <td />}
                    <td className="tabular px-2 py-2 text-right">{totals.qty}</td>
                    {biz.costsAnywhere && <td className="tabular whitespace-nowrap px-2 py-2 text-right">{fmtMoney(totals.value / 100, cur)}</td>}
                    <td colSpan={2} />
                  </tr>
                </tbody>
              </table>
              <datalist id="import-cats">{categoryNames.map((c) => <option key={c} value={c} />)}</datalist>
            </div>
            {removed.size > 0 && <div className="border-t border-slate-100 px-4 py-2 text-sm text-slate-600">{removed.size} row{removed.size > 1 ? "s" : ""} left out. <button className="inline-flex items-center gap-1 font-semibold text-brand" onClick={() => setRemoved(new Set())}><RotateCcw className="size-3.5" /> Bring back</button></div>}
          </Card>

          <Card className="space-y-3 p-4">
            {serverErrors.length > 0 && <Alert tone="danger" title="Nothing was imported">Fix the rows marked in red above, then tap Import again.</Alert>}
            {source === "reader" && map.name === undefined && <Alert tone="warning">Choose which column holds the product name (step 2).</Alert>}
            <Button size="lg" block disabled={(source === "reader" && map.name === undefined) || badRows > 0 || !rows.length} loading={busy} onClick={commit}>
              Import {rows.length} product{rows.length === 1 ? "" : "s"}
            </Button>
            <p className="text-xs text-slate-500">All-or-nothing: if any row fails, nothing is saved. Products without photos get a placeholder you can replace any time.</p>
          </Card>
        </>
      )}
    </div>
  );
}

function GroupRows({ g, errorsFor, costs, cur, lineValue, setEdit, remove }: {
  g: { category: string; rows: (ImportRow & { _i: number })[]; idx: number[] };
  errorsFor: (k: number) => string[]; costs: boolean; cur: string; lineValue: (r: ImportRow) => number;
  setEdit: (i: number, k: EditKey, v: string) => void; remove: (i: number) => void;
}) {
  const sub = g.rows.reduce((a, r) => a + lineValue(r), 0);
  const qty = g.rows.reduce((a, r) => a + (Number(r.opening_stock) || 0), 0);
  const cell = "h-8 w-full rounded-lg border border-transparent bg-transparent px-1.5 text-sm hover:border-slate-300 focus:border-brand focus:bg-white focus:outline-none";
  return (
    <>
      <tr className="bg-brand-50/60"><td colSpan={costs ? 7 : 5} className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-brand-800">{g.category}</td></tr>
      {g.rows.map((o, j) => {
        const k = g.idx[j];
        const errs = errorsFor(k);
        return (
          <tr key={o._i} className={cx("border-t border-slate-100 align-top", errs.length > 0 && "bg-red-50")}>
            <td className="px-1 py-1">
              <input aria-label="Name" className={cx(cell, "min-w-48")} value={o.name} onChange={(e) => setEdit(o._i, "name", e.target.value)} />
              {o.name !== o.source_name && !o._note && <span className="block px-1.5 text-[11px] text-slate-500">in file: {o.source_name}</span>}
              {o._note && <span className="block px-1.5 text-[11px] font-medium text-amber-800">{o._note}</span>}
              {errs.length > 0 && <span className="block px-1.5 text-[11px] font-medium text-red-700">{errs.join("; ")}</span>}
            </td>
            <td className="px-1 py-1"><input aria-label="Category" list="import-cats" className={cx(cell, "min-w-28")} value={o.category} onChange={(e) => setEdit(o._i, "category", e.target.value)} /></td>
            {costs && <td className="px-1 py-1"><input aria-label="Cost" inputMode="decimal" className={cx(cell, "tabular w-20 text-right", !o.unit_cost && Number(o.opening_stock) > 0 && "border-amber-300")} value={o.unit_cost} placeholder="—" onChange={(e) => setEdit(o._i, "unit_cost", e.target.value.replace(/[^\d.]/g, ""))} /></td>}
            <td className="px-1 py-1"><input aria-label="Quantity" inputMode="numeric" className={cx(cell, "tabular w-14 text-right")} value={o.opening_stock} placeholder="0" onChange={(e) => setEdit(o._i, "opening_stock", e.target.value.replace(/\D/g, ""))} /></td>
            {costs && <td className="tabular whitespace-nowrap px-2 py-2 text-right text-slate-600">{lineValue(o) ? fmtMoney(lineValue(o) / 100, cur) : "—"}</td>}
            <td className="px-1 py-1"><input aria-label="Selling price" inputMode="decimal" className={cx(cell, "tabular w-20 text-right")} value={o.target_price} placeholder="later" onChange={(e) => setEdit(o._i, "target_price", e.target.value.replace(/[^\d.]/g, ""))} /></td>
            <td className="px-1 py-1"><button onClick={() => remove(o._i)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label={`Leave out ${o.name}`}><Trash2 className="size-4" /></button></td>
          </tr>
        );
      })}
      <tr className="border-t border-slate-200 text-xs text-slate-600">
        <td className="px-2 py-1.5" colSpan={2}>Subtotal {g.category} · {g.rows.length} product{g.rows.length === 1 ? "" : "s"}</td>
        {costs && <td />}
        <td className="tabular px-2 py-1.5 text-right">{qty}</td>
        {costs && <td className="tabular whitespace-nowrap px-2 py-1.5 text-right font-semibold">{fmtMoney(sub / 100, cur)}</td>}
        <td colSpan={2} />
      </tr>
    </>
  );
}

export default function ImportPage() {
  return <Suspense><ImportInner /></Suspense>;
}
