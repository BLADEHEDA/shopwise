"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import Papa from "papaparse";
import { ChevronLeft, FileSpreadsheet, Download, CircleCheck } from "lucide-react";
import { useBiz } from "@/components/biz";
import { useToast } from "@/components/toast";
import { Alert, Badge, Button, Card, Field, PageHeader, Select } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { toMinor } from "@/lib/money";
import { cx, downloadCsv, errorMessage } from "@/lib/format";

const FIELDS = [
  { key: "section", label: "Section", required: true, aliases: ["section", "department", "unit"] },
  { key: "name", label: "Product name", required: true, aliases: ["name", "product", "product name", "item", "description_short"] },
  { key: "target_price", label: "Target price", required: true, aliases: ["target_price", "target price", "price", "selling price", "sale price", "retail price"] },
  { key: "min_price", label: "Minimum price", aliases: ["min_price", "minimum price", "min price", "floor price", "lowest price"] },
  { key: "category", label: "Category", aliases: ["category", "type", "group"] },
  { key: "brand", label: "Brand", aliases: ["brand", "make"] },
  { key: "model", label: "Model", aliases: ["model"] },
  { key: "variant_label", label: "Variant", aliases: ["variant", "variant_label", "size", "colour", "color"] },
  { key: "sku", label: "SKU", aliases: ["sku", "code", "item code", "product code", "barcode"] },
  { key: "opening_stock", label: "Opening stock", aliases: ["opening_stock", "stock", "quantity", "qty", "opening stock", "in stock"] },
  { key: "unit_cost", label: "Unit cost (owner only)", aliases: ["unit_cost", "cost", "cost price", "buying price", "purchase price", "landed cost"] },
  { key: "low_stock_threshold", label: "Low-stock level", aliases: ["low_stock_threshold", "reorder level", "low stock", "min stock"] },
  { key: "description", label: "Description", aliases: ["description", "details", "notes"] },
] as const;
type Key = (typeof FIELDS)[number]["key"];

export default function ImportPage() {
  const biz = useBiz();
  const toast = useToast();
  const [file, setFile] = useState<string | null>(null);
  const [rows, setRows] = useState<string[][]>([]);
  const [map, setMap] = useState<Partial<Record<Key, number>>>({});
  const [mode, setMode] = useState<"skip" | "update">("skip");
  const [serverErrors, setServerErrors] = useState<{ row: number; message: string }[]>([]);
  const [result, setResult] = useState<{ inserted: number; updated: number; skipped: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const header = rows[0] || [];
  const body = rows.slice(1).filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
  const sectionNames = biz.sections.filter((s) => biz.canManage(s.id)).map((s) => s.name.toLowerCase());

  async function onFile(f: File) {
    setErr(null); setResult(null); setServerErrors([]);
    try {
      let data: string[][] = [];
      if (/\.xlsx$/i.test(f.name)) {
        const { readSheet } = await import("read-excel-file/browser");
        const sheet = await readSheet(f);
        data = (sheet as unknown[][]).map((r) => r.map((c) => (c === null || c === undefined ? "" : String(c))));
      } else if (/\.(csv|txt)$/i.test(f.name)) {
        const text = await f.text();
        data = Papa.parse<string[]>(text, { skipEmptyLines: true }).data;
      } else {
        setErr("Choose an .xlsx or .csv file. (Old .xls files: open in Excel and 'Save as' .xlsx first.)");
        return;
      }
      if (data.length < 2) { setErr("The file has no product rows."); return; }
      setFile(f.name);
      setRows(data);
      const auto: Partial<Record<Key, number>> = {};
      data[0].forEach((h, i) => {
        const n = String(h).trim().toLowerCase();
        const fld = FIELDS.find((x) => (x.aliases as readonly string[]).includes(n));
        if (fld && auto[fld.key] === undefined) auto[fld.key] = i;
      });
      setMap(auto);
    } catch (e) { setErr(`Could not read the file: ${errorMessage(e)}`); }
  }

  const mapped = useMemo(() => body.map((r) => {
    const o: Record<string, string> = {};
    for (const f of FIELDS) { const i = map[f.key]; o[f.key] = i === undefined ? "" : String(r[i] ?? "").trim().replace(/^(\d[\d,]*\.?\d*)\s*(fcfa|xaf|cfa)?$/i, (_, n) => n.replace(/,/g, "")); }
    if (biz.sections.length === 1 && !o.section) o.section = biz.sections[0].name;
    return o;
  }), [body, map, biz.sections]);

  const clientErrors = useMemo(() => {
    const seen = new Set<string>();
    return mapped.map((o) => {
      const errs: string[] = [];
      if (!o.name) errs.push("Name missing");
      if (!o.section) errs.push("Section missing");
      else if (!sectionNames.includes(o.section.toLowerCase())) errs.push(`Unknown section "${o.section}"`);
      const t = toMinor(o.target_price), m = o.min_price ? toMinor(o.min_price) : t;
      if (!(t > 0)) errs.push("Target price must be a number above 0");
      else if (!(m > 0) || m > t) errs.push("Minimum must be between 1 and target");
      if (o.opening_stock && !/^\d+(\.0+)?$/.test(o.opening_stock)) errs.push("Stock must be a whole number");
      if (o.unit_cost && Number.isNaN(toMinor(o.unit_cost))) errs.push("Cost must be a number");
      if (o.sku) { const k = o.sku.toLowerCase(); if (seen.has(k)) errs.push("SKU repeated in file"); seen.add(k); }
      return errs;
    });
  }, [mapped, sectionNames]);
  const badRows = clientErrors.filter((e) => e.length).length;
  const requiredMapped = FIELDS.filter((f) => "required" in f && f.required && f.key !== "section").every((f) => map[f.key] !== undefined) && (map.section !== undefined || biz.sections.length === 1);

  async function commit() {
    setBusy(true); setErr(null); setServerErrors([]);
    const payload = mapped.map((o) => (biz.costsAnywhere ? o : { ...o, unit_cost: "" }));
    const { data, error } = await supabase().rpc("import_products", { p_business: biz.business.id, p_rows: payload, p_mode: mode });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    const res = data as { ok: boolean; errors?: { row: number; message: string }[]; inserted: number; updated: number; skipped: number };
    if (!res.ok) { setServerErrors(res.errors || []); return; }
    setResult(res);
    toast(`Imported ${res.inserted} products`);
  }

  function template() {
    downloadCsv("products-template.csv", [
      ["section", "category", "name", "variant", "brand", "model", "sku", "target_price", "min_price", "opening_stock", "unit_cost", "low_stock_threshold"],
      [biz.sections[0]?.name || "Electronics", "Audio", "Wireless Headset", "", "Oraimo", "FreePods 4", "HS-001", "15000", "12000", "10", "8500", "3"],
      [biz.sections[1]?.name || biz.sections[0]?.name || "Components", "Puzzles", "Rubik's Cube", "3x3", "", "", "RC-3", "3000", "2500", "25", "1200", "5"],
    ]);
  }

  if (result) {
    return (
      <div className="mx-auto max-w-lg space-y-4 pt-6 text-center">
        <CircleCheck className="mx-auto size-14 text-emerald-600" />
        <h1 className="text-2xl font-bold">Import complete</h1>
        <p className="text-slate-600">{result.inserted} added · {result.updated} updated · {result.skipped} skipped (SKU already existed)</p>
        <div className="flex justify-center gap-2">
          <Link href="/app/products"><Button>View products</Button></Link>
          <Button variant="secondary" onClick={() => { setResult(null); setRows([]); setFile(null); }}>Import another file</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Link href="/app/products" className="inline-flex items-center gap-1 text-sm font-medium text-slate-600"><ChevronLeft className="size-4" /> Products</Link>
      <PageHeader title="Import products" subtitle="From Excel (.xlsx) or CSV. Nothing is saved until you confirm." actions={<Button variant="secondary" onClick={template}><Download className="size-4" /> Template</Button>} />

      <Card className="p-4">
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 p-8 text-center hover:border-brand hover:bg-brand-50">
          <FileSpreadsheet className="size-10 text-brand" />
          <span className="font-semibold">{file || "Choose a file"}</span>
          <span className="text-sm text-slate-500">{file ? `${body.length} rows found · tap to choose another` : "First row must be column headings"}</span>
          <input type="file" accept=".xlsx,.csv,.txt" className="sr-only" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        </label>
        {err && <Alert tone="danger" className="mt-3">{err}</Alert>}
      </Card>

      {rows.length > 0 && (
        <>
          <Card className="p-4">
            <h2 className="mb-1 font-semibold">1. Match your columns</h2>
            <p className="mb-3 text-sm text-slate-500">We guessed from your headings. Fix any that are wrong.</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {FIELDS.filter((f) => f.key !== "unit_cost" || biz.costsAnywhere).map((f) => (
                <Field key={f.key} label={`${f.label}${"required" in f && f.required ? " *" : ""}`}>
                  <Select value={map[f.key] ?? ""} onChange={(e) => setMap({ ...map, [f.key]: e.target.value === "" ? undefined : Number(e.target.value) })}>
                    <option value="">— not in file —</option>
                    {header.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                  </Select>
                </Field>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-500">Sections in your business: {biz.sections.map((s) => s.name).join(", ")}. The section column must use these names.</p>
          </Card>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
              <h2 className="font-semibold">2. Preview</h2>
              {badRows ? <Badge tone="danger">{badRows} row{badRows > 1 ? "s" : ""} with problems</Badge> : <Badge tone="success">All {body.length} rows look good</Badge>}
            </div>
            <div className="max-h-[420px] overflow-auto">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500">
                  <tr><th className="px-3 py-2">Row</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">Section</th><th className="px-3 py-2 text-right">Target</th><th className="px-3 py-2 text-right">Min</th><th className="px-3 py-2 text-right">Stock</th><th className="px-3 py-2">Status</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {mapped.map((o, i) => {
                    const se = serverErrors.find((x) => x.row === i + 1);
                    const errs = [...clientErrors[i], ...(se ? [se.message] : [])];
                    return (
                      <tr key={i} className={cx(errs.length > 0 && "bg-red-50")}>
                        <td className="px-3 py-2 text-slate-500">{i + 2}</td>
                        <td className="px-3 py-2">{o.name}{o.variant_label ? ` (${o.variant_label})` : ""}<span className="block text-xs text-slate-500">{[o.brand, o.sku].filter(Boolean).join(" · ")}</span></td>
                        <td className="px-3 py-2">{o.section}</td>
                        <td className="tabular px-3 py-2 text-right">{o.target_price}</td>
                        <td className="tabular px-3 py-2 text-right">{o.min_price || o.target_price}</td>
                        <td className="tabular px-3 py-2 text-right">{o.opening_stock || 0}</td>
                        <td className="px-3 py-2">{errs.length ? <span className="text-xs font-medium text-red-700">{errs.join("; ")}</span> : <span className="text-xs text-emerald-700">OK</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="space-y-3 p-4">
            <h2 className="font-semibold">3. Import</h2>
            <Field label="If a SKU already exists">
              <Select value={mode} onChange={(e) => setMode(e.target.value as "skip" | "update")}>
                <option value="skip">Skip it (keep the existing product)</option>
                <option value="update">Update its name, prices and details</option>
              </Select>
            </Field>
            {serverErrors.length > 0 && <Alert tone="danger" title="Nothing was imported">Fix the rows marked in red, then try again.</Alert>}
            {!requiredMapped && <Alert tone="warning">Match the required columns (*) first.</Alert>}
            <Button size="lg" block disabled={!requiredMapped || badRows > 0} loading={busy} onClick={commit}>
              Import {body.length} product{body.length === 1 ? "" : "s"}
            </Button>
            <p className="text-xs text-slate-500">Opening stock is recorded in the stock history as &quot;opening&quot;. The import is all-or-nothing: if any row fails, nothing is saved.</p>
          </Card>
        </>
      )}
    </div>
  );
}
