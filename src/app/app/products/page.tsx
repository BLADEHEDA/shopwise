"use client";
import { Fragment, Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Flag, MoreVertical, Package, Pencil, Plus, Search, Upload, X } from "lucide-react";
import { useBiz } from "@/components/biz";
import { EditablePhoto, PhotoButton, ProductThumb } from "@/components/product-photo";
import { FlagSheet, NotSet } from "@/components/stock-bits";
import { Badge, Button, Card, EmptyState, Input, MoneyInput, PageHeader, Select, Sheet, Spinner } from "@/components/ui";
import { useToast } from "@/components/toast";
import { supabase } from "@/lib/supabase";
import { fmtMoney, fmtNumber, minorToDecimal, toMinor } from "@/lib/money";
import { cx, downloadCsv, errorMessage } from "@/lib/format";
import type { Product } from "@/lib/types";

type Filter = "active" | "needs_price" | "no_photo" | "inactive" | "all";
const NO_CAT = "No category";
const catOf = (p: Product) => p.categories?.name || NO_CAT;

function ProductsInner() {
  const biz = useBiz();
  const { business, sections } = biz;
  const toast = useToast();
  const initial = (useSearchParams().get("filter") as Filter) || "active";
  const [products, setProducts] = useState<Product[] | null>(null);
  const [costs, setCosts] = useState<Record<string, number>>({});
  const [q, setQ] = useState("");
  const [section, setSection] = useState("all");
  const [category, setCategory] = useState("all");
  const [filter, setFilter] = useState<Filter>(initial);
  const [open, setOpen] = useState<Product | null>(null);
  const [flagFor, setFlagFor] = useState<Product | null>(null);
  const cur = business.currency;
  const seeCosts = biz.costsAnywhere;

  useEffect(() => {
    const sb = supabase();
    sb.from("products").select("*, categories(name)").eq("business_id", business.id).order("name").then(({ data }) => setProducts((data || []) as Product[]));
    if (seeCosts) {
      sb.from("product_costs").select("product_id, avg_cost").eq("business_id", business.id).then(({ data }) => {
        const m: Record<string, number> = {};
        for (const r of (data || []) as { product_id: string; avg_cost: number }[]) m[r.product_id] = r.avg_cost;
        setCosts(m);
      });
    }
  }, [business.id, seeCosts]);

  const patch = (id: string, ch: Partial<Product>) => {
    setProducts((ps) => (ps || []).map((p) => (p.id === id ? { ...p, ...ch } : p)));
    setOpen((o) => (o && o.id === id ? { ...o, ...ch } : o));
  };
  const secName = (id: string) => sections.find((s) => s.id === id)?.name || "";

  // everything except the category: the bar shows counts for what's left
  const base = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (products || []).filter((p) =>
      (section === "all" || p.section_id === section) &&
      (filter === "all" || (filter === "inactive" ? !p.active : p.active && (filter === "active" || (filter === "needs_price" ? p.target_price === null || p.min_price === null : !p.image_url)))) &&
      (!s || [p.name, p.brand, p.model, p.sku, p.barcode, p.variant_label, p.categories?.name].some((v) => v && v.toLowerCase().includes(s))));
  }, [products, q, section, filter]);

  const catCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of base) m.set(catOf(p), (m.get(catOf(p)) || 0) + 1);
    return Array.from(m.entries()).sort((a, b) => (a[0] === NO_CAT ? 1 : b[0] === NO_CAT ? -1 : a[0].localeCompare(b[0])));
  }, [base]);

  const list = useMemo(() => base.filter((p) => category === "all" || catOf(p) === category)
    .sort((a, b) => catOf(a).localeCompare(catOf(b)) || a.name.localeCompare(b.name)), [base, category]);

  const counts = useMemo(() => {
    const act = (products || []).filter((p) => p.active);
    return { active: act.length, needsPrice: act.filter((p) => p.target_price === null || p.min_price === null).length, noPhoto: act.filter((p) => !p.image_url).length };
  }, [products]);

  const groups: { name: string; rows: Product[] }[] = [];
  for (const p of list) {
    const g = groups[groups.length - 1];
    if (g && g.name === catOf(p)) g.rows.push(p); else groups.push({ name: catOf(p), rows: [p] });
  }
  const showGroups = category === "all" && groups.length > 1;
  const cols = 4 + (seeCosts ? 1 : 0);

  function exportCsv() {
    const header = ["section", "category", "name", "variant_label", "brand", "model", "sku", "stock", ...(seeCosts ? ["cost_price"] : []), "min_price", "target_price", "low_stock_threshold", "active"];
    downloadCsv(`products-${new Date().toISOString().slice(0, 10)}.csv`, [header, ...list.map((p) => [
      secName(p.section_id), p.categories?.name || "", p.name, p.variant_label, p.brand, p.model, p.sku, p.stock_qty,
      ...(seeCosts ? [biz.canViewCosts(p.section_id) ? costs[p.id] ?? "" : ""] : []), p.min_price, p.target_price, p.low_stock_threshold, p.active ? "yes" : "no"])]);
  }

  const chip = (value: string, label: string, n: number) => (
    <button key={value} onClick={() => setCategory(value)} aria-pressed={category === value}
      className={cx("shrink-0 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-sm font-medium transition",
        category === value ? "border-brand bg-brand text-white shadow-sm" : "border-slate-300 bg-white text-slate-700 hover:border-brand hover:text-brand")}>
      {label} <span className={cx("tabular text-xs", category === value ? "text-white/80" : "text-slate-400")}>{n}</span>
    </button>
  );

  return (
    <div>
      <PageHeader title="Products" subtitle={`${counts.active} active products`}
        actions={biz.canManageAny && (
          <>
            <Link href="/app/products/import"><Button variant="secondary"><Upload className="size-4" /> Import</Button></Link>
            <Link href="/app/products/edit"><Button><Plus className="size-4" /> Add product</Button></Link>
          </>
        )} />

      {/* search + category bar stay on screen while scrolling */}
      <div className="sticky top-[var(--header-h,57px)] z-20 -mx-4 mb-3 space-y-2 border-b border-slate-200 bg-slate-50/95 px-4 pb-2 pt-2 backdrop-blur lg:-mx-8 lg:px-8">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <Input className="pl-9 pr-9" placeholder="Search product, brand, model" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search products" />
          {q && <button onClick={() => setQ("")} className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full text-slate-400 hover:text-ink" aria-label="Clear search"><X className="size-4" /></button>}
        </div>
        {catCounts.length > 1 && (
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:-mx-8 lg:px-8" role="group" aria-label="Categories">
            {chip("all", "All", base.length)}
            {catCounts.map(([c, n]) => chip(c, c, n))}
          </div>
        )}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {counts.needsPrice > 0 && (
          <button onClick={() => setFilter(filter === "needs_price" ? "active" : "needs_price")} aria-pressed={filter === "needs_price"}
            className={cx("h-9 rounded-full border px-3 text-sm font-medium", filter === "needs_price" ? "border-red-500 bg-red-100 text-red-800" : "border-red-200 bg-red-50 text-red-700")}>
            {counts.needsPrice} without selling price{filter === "needs_price" ? " ✕" : ""}
          </button>
        )}
        {counts.noPhoto > 0 && (
          <button onClick={() => setFilter(filter === "no_photo" ? "active" : "no_photo")} aria-pressed={filter === "no_photo"}
            className={cx("h-9 rounded-full border px-3 text-sm font-medium", filter === "no_photo" ? "border-brand bg-brand-100 text-brand-800" : "border-brand-200 bg-brand-50 text-brand-700")}>
            {counts.noPhoto} without a photo{filter === "no_photo" ? " ✕" : ""}
          </button>
        )}
        {sections.length > 1 && (
          <div className="w-40"><Select value={section} onChange={(e) => setSection(e.target.value)} aria-label="Section">
            <option value="all">All sections</option>{sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select></div>
        )}
        {biz.canManageAny && (
          <div className="w-36"><Select value={filter === "inactive" || filter === "all" ? filter : "active"} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Show">
            <option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option>
          </Select></div>
        )}
      </div>

      {products === null ? <Spinner /> : list.length === 0 ? (
        <Card><EmptyState icon={<Package className="size-6" />} title={products.length ? "No products match" : "No products yet"}
          action={biz.canManageAny && !products.length ? <div className="flex gap-2"><Link href="/app/products/import"><Button variant="secondary">Import from Excel</Button></Link><Link href="/app/products/edit"><Button>Add product</Button></Link></div> : undefined}>
          {products.length ? "Try a different search or category." : "Import your product list or add products one by one."}
        </EmptyState></Card>
      ) : (
        <Card className="overflow-hidden">
          {seeCosts && <p className="border-b border-slate-100 px-3 py-1.5 text-xs text-slate-500 sm:hidden">Swipe the table left to see all prices →</p>}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px] sm:text-sm">
              <thead className="bg-slate-800 text-left text-xs font-semibold uppercase tracking-wide text-white">
                <tr>
                  <th className="sticky left-0 z-[1] bg-slate-800 px-2 py-2.5 sm:px-3">Product</th>
                  <th className="px-2 py-2.5 text-right sm:px-3">Qty</th>
                  {seeCosts && <th className="px-2 py-2.5 text-right sm:px-3"><span className="sm:hidden">Cost</span><span className="hidden sm:inline">Cost price</span></th>}
                  <th className="px-2 py-2.5 text-right text-amber-200 sm:px-3">Min price</th>
                  <th className="px-2 py-2.5 text-right text-emerald-200 sm:px-3">Target price</th>
                  <th className="hidden w-8 px-1 py-2.5 sm:table-cell" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <Fragment key={g.name}>
                    {showGroups && (
                      <tr className="bg-brand-50"><td colSpan={cols + 1} className="px-2 py-2 text-xs font-bold uppercase tracking-wide text-brand-800 sm:px-3">{g.name} <span className="font-medium text-brand-800/60">· {g.rows.length}</span></td></tr>
                    )}
                    {g.rows.map((p, i) => {
                      const low = p.stock_qty <= p.low_stock_threshold;
                      const cost = biz.canViewCosts(p.section_id) ? costs[p.id] : undefined;
                      return (
                        <tr key={p.id} onClick={() => setOpen(p)} className={cx("cursor-pointer border-t border-slate-100 hover:bg-brand-50", i % 2 === 1 ? "bg-slate-50" : "bg-white", !p.active && "opacity-60")}>
                          <td className="sticky left-0 bg-inherit px-2 py-1.5 sm:px-3">
                            <div className="flex min-w-[9.5rem] items-center gap-2.5">
                              <EditablePhoto product={p} onDone={(url) => patch(p.id, { image_url: url })} className="size-10 sm:size-11" />
                              <div className="min-w-0">
                                <p className="line-clamp-2 font-medium leading-snug [overflow-wrap:anywhere]">{p.name}{p.variant_label ? <span className="font-normal text-slate-500"> ({p.variant_label})</span> : null}</p>
                                {(sections.length > 1 || p.brand || !p.active) && (
                                  <p className="truncate text-[11px] text-slate-500">{!p.active && "Inactive · "}{[sections.length > 1 ? secName(p.section_id) : "", p.brand].filter(Boolean).join(" · ")}</p>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="tabular whitespace-nowrap px-2 py-1.5 text-right sm:px-3">
                            <span className={cx("font-semibold", p.stock_qty === 0 ? "text-red-600" : low ? "text-amber-700" : "")}>{p.stock_qty}</span>
                            {low && <span className={cx("block text-[10px] font-semibold uppercase leading-none sm:ml-1 sm:inline", p.stock_qty === 0 ? "text-red-600" : "text-amber-700")}>{p.stock_qty === 0 ? "out" : "low"}</span>}
                          </td>
                          {seeCosts && <td className="tabular whitespace-nowrap px-2 py-1.5 text-right text-slate-700 sm:px-3">{cost === undefined ? <span className="text-slate-300">—</span> : cost > 0 ? fmtNumber(cost) : <NotSet />}</td>}
                          <td className="tabular whitespace-nowrap px-2 py-1.5 text-right text-amber-800 sm:px-3">{p.min_price === null ? <NotSet /> : fmtNumber(p.min_price)}</td>
                          <td className="tabular whitespace-nowrap px-2 py-1.5 text-right font-semibold text-emerald-800 sm:px-3">{p.target_price === null ? <NotSet /> : fmtNumber(p.target_price)}</td>
                          <td className="hidden px-1 py-1.5 text-slate-400 sm:table-cell"><MoreVertical className="size-4" /></td>
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span>Prices in {cur}. Tap a product for details{biz.canManageAny ? ", to set prices or edit it" : ""}. Tap a photo to {biz.canManageAny ? "change" : "add"} it.</span>
        {list.length > 0 && biz.canReport && <Button variant="ghost" size="sm" onClick={exportCsv}>Export CSV</Button>}
      </div>

      {open && (
        <ProductSheet product={open} cost={biz.canViewCosts(open.section_id) ? costs[open.id] : undefined} section={secName(open.section_id)} showSection={sections.length > 1}
          onClose={() => setOpen(null)} onPatch={(ch) => patch(open.id, ch)} onFlag={() => { setFlagFor(open); setOpen(null); }} />
      )}
      {flagFor && <FlagSheet product={flagFor} onClose={() => setFlagFor(null)} onDone={() => { setFlagFor(null); toast("Thanks, the manager has been notified"); }} />}
    </div>
  );
}

function ProductSheet({ product: p, cost, section, showSection, onClose, onPatch, onFlag }: {
  product: Product; cost?: number; section: string; showSection: boolean;
  onClose: () => void; onPatch: (ch: Partial<Product>) => void; onFlag: () => void;
}) {
  const biz = useBiz();
  const cur = biz.business.currency;
  const editable = biz.canManage(p.section_id);
  const margin = cost !== undefined && cost > 0 && p.target_price ? Math.round(((p.target_price - cost) / p.target_price) * 100) : null;
  const low = p.stock_qty <= p.low_stock_threshold;
  return (
    <Sheet open onClose={onClose} title={p.name + (p.variant_label ? ` (${p.variant_label})` : "")}>
      <div className="space-y-4">
        <div className="flex items-start gap-4">
          <div className="size-28 shrink-0 overflow-hidden rounded-2xl border border-slate-200"><ProductThumb product={p} iconClass="size-10" /></div>
          <div className="min-w-0 space-y-1 text-sm">
            <p className="text-slate-600">{[p.categories?.name, showSection ? section : "", p.brand, p.model].filter(Boolean).join(" · ") || "No category"}</p>
            {p.sku && <p className="text-xs text-slate-500">SKU {p.sku}</p>}
            {!p.active && <Badge>Inactive</Badge>}
            <div className="pt-1"><PhotoButton product={p} onDone={(url) => onPatch({ image_url: url })} /></div>
          </div>
        </div>

        <div className={cx("grid gap-2", cost !== undefined ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3")}>
          <Fact label="In stock" tone={p.stock_qty === 0 ? "red" : low ? "amber" : undefined} value={`${p.stock_qty}${p.stock_qty === 0 ? " · out" : low ? " · low" : ""}`} />
          {cost !== undefined && <Fact label="Cost price" value={cost > 0 ? fmtMoney(cost, cur) : null} sub={margin !== null ? `${margin}% margin at target` : undefined} />}
          <Fact label="Min price" tone="amber" value={p.min_price === null ? null : fmtMoney(p.min_price, cur)} />
          <Fact label="Target price" tone="green" value={p.target_price === null ? null : fmtMoney(p.target_price, cur)} />
        </div>

        {editable ? (
          <QuickPrice product={p} cost={cost} cur={cur} onSaved={(t, m) => onPatch({ target_price: t, min_price: m })} />
        ) : (p.target_price === null || p.min_price === null) && (
          <p className="rounded-xl bg-red-50 p-3 text-sm text-red-800">The selling price is not set yet. Ask the manager before selling this item.</p>
        )}

        <div className="grid gap-2">
          {editable && <Link href={`/app/products/edit?id=${p.id}`}><Button variant="secondary" block><Pencil className="size-4" /> Edit product details</Button></Link>}
          {!editable && <Button variant="secondary" onClick={onFlag}><Flag className="size-4" /> Report low stock / new arrival</Button>}
        </div>
      </div>
    </Sheet>
  );
}

function Fact({ label, value, sub, tone }: { label: string; value: string | null; sub?: string; tone?: "red" | "amber" | "green" }) {
  const c = tone === "red" ? "text-red-700" : tone === "amber" ? "text-amber-800" : tone === "green" ? "text-emerald-800" : "text-ink";
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-2.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={cx("tabular mt-0.5 font-bold", c)}>{value === null ? <NotSet /> : value}</p>
      {sub && <p className="text-[11px] text-slate-500">{sub}</p>}
    </div>
  );
}

/** Set or change the selling prices right from the product sheet. */
function QuickPrice({ product, cost, cur, onSaved }: { product: Product; cost?: number; cur: string; onSaved: (target: number, min: number) => void }) {
  const toast = useToast();
  const [target, setTarget] = useState(product.target_price !== null ? String(product.target_price) : "");
  const [min, setMin] = useState(product.min_price !== null ? String(product.min_price) : "");
  const [busy, setBusy] = useState(false);
  const missing = product.target_price === null || product.min_price === null;
  async function save() {
    const t = toMinor(target), m = toMinor(min || target);
    if (!(t > 0)) { toast("Enter the target price", "error"); return; }
    if (!(m > 0) || m > t) { toast("Minimum must be between 1 and the target price", "error"); return; }
    setBusy(true);
    const { error } = await supabase().from("products").update({ target_price: minorToDecimal(t), min_price: minorToDecimal(m) }).eq("id", product.id);
    setBusy(false);
    if (error) { toast(errorMessage(error), "error"); return; }
    toast(`${product.name}: ${fmtMoney(minorToDecimal(t), cur)} (min ${fmtMoney(minorToDecimal(m), cur)})`);
    onSaved(t / 100, m / 100);
  }
  const below = (v: string) => cost !== undefined && cost > 0 && v !== "" && toMinor(v) < toMinor(cost);
  return (
    <form onSubmit={(e) => { e.preventDefault(); save(); }} className={cx("rounded-2xl border p-3", missing ? "border-red-200 bg-red-50/60" : "border-slate-200 bg-slate-50")}>
      <p className={cx("mb-2 text-sm font-semibold", missing ? "text-red-800" : "text-slate-700")}>{missing ? "Set the selling prices" : "Selling prices"}</p>
      <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
        <label className="text-xs font-medium text-amber-800">Min price
          <MoneyInput aria-label={`Minimum price for ${product.name}`} placeholder="Min" value={min} onChange={setMin} className={cx("mt-1 h-11 text-right", below(min) && "border-red-500")} />
        </label>
        <label className="text-xs font-medium text-emerald-800">Target price
          <MoneyInput aria-label={`Target price for ${product.name}`} placeholder="Target" value={target} onChange={setTarget} className={cx("mt-1 h-11 text-right", below(target) && "border-red-500")} />
        </label>
        <Button type="submit" loading={busy} className="h-11">Save</Button>
      </div>
      {(below(min) || below(target)) && <p className="mt-1.5 text-xs font-medium text-red-700">Below the cost price ({fmtMoney(cost!, cur)}): you would sell at a loss.</p>}
    </form>
  );
}

export default function ProductsPage() {
  return <Suspense><ProductsInner /></Suspense>;
}
