"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Package, Plus, Search, Upload } from "lucide-react";
import { useBiz } from "@/components/biz";
import { ProductThumb, PhotoButton } from "@/components/product-photo";
import { Badge, Button, Card, EmptyState, Input, MoneyInput, PageHeader, Select, Spinner } from "@/components/ui";
import { useToast } from "@/components/toast";
import { supabase } from "@/lib/supabase";
import { fmtMoney, minorToDecimal, toMinor } from "@/lib/money";
import { cx, downloadCsv, errorMessage } from "@/lib/format";
import type { Product } from "@/lib/types";

type Filter = "active" | "needs_price" | "no_photo" | "inactive" | "all";

function ProductsInner() {
  const biz = useBiz();
  const { business, sections } = biz;
  const initial = (useSearchParams().get("filter") as Filter) || "active";
  const [products, setProducts] = useState<Product[] | null>(null);
  const [costs, setCosts] = useState<Record<string, number>>({});
  const [q, setQ] = useState("");
  const [section, setSection] = useState("all");
  const [category, setCategory] = useState("all");
  const [filter, setFilter] = useState<Filter>(initial);
  const cur = business.currency;

  useEffect(() => {
    const sb = supabase();
    sb.from("products").select("*, categories(name)").eq("business_id", business.id).order("name").then(({ data }) => setProducts((data || []) as Product[]));
    if (biz.costsAnywhere) {
      sb.from("product_costs").select("product_id, avg_cost").eq("business_id", business.id).then(({ data }) => {
        const m: Record<string, number> = {};
        for (const r of (data || []) as { product_id: string; avg_cost: number }[]) m[r.product_id] = r.avg_cost;
        setCosts(m);
      });
    }
  }, [business.id, biz.costsAnywhere]);

  const secName = (id: string) => sections.find((s) => s.id === id)?.name || "";
  const categories = useMemo(() => Array.from(new Set((products || []).map((p) => p.categories?.name).filter(Boolean))) as string[], [products]);
  const counts = useMemo(() => {
    const act = (products || []).filter((p) => p.active);
    return { needsPrice: act.filter((p) => p.target_price === null).length, noPhoto: act.filter((p) => !p.image_url).length };
  }, [products]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (products || []).filter((p) =>
      (section === "all" || p.section_id === section) &&
      (category === "all" || p.categories?.name === category) &&
      (filter === "all" || (filter === "inactive" ? !p.active : p.active && (filter === "active" || (filter === "needs_price" ? p.target_price === null : !p.image_url)))) &&
      (!s || [p.name, p.brand, p.model, p.sku, p.barcode, p.variant_label, p.categories?.name].some((v) => v && v.toLowerCase().includes(s))));
  }, [products, q, section, category, filter]);

  function setImage(id: string, url: string) {
    setProducts((ps) => (ps || []).map((p) => (p.id === id ? { ...p, image_url: url } : p)));
  }

  function exportCsv() {
    const header = ["section", "category", "name", "variant_label", "brand", "model", "sku", "target_price", "min_price", "stock", "low_stock_threshold", "active"];
    if (biz.costsAnywhere) header.push("unit_cost");
    downloadCsv(`products-${new Date().toISOString().slice(0, 10)}.csv`, [header, ...list.map((p) => {
      const r: (string | number | null)[] = [secName(p.section_id), p.categories?.name || "", p.name, p.variant_label, p.brand, p.model, p.sku, p.target_price, p.min_price, p.stock_qty, p.low_stock_threshold, p.active ? "yes" : "no"];
      if (biz.costsAnywhere) r.push(costs[p.id] ?? "");
      return r;
    })]);
  }

  return (
    <div>
      <PageHeader title="Products" subtitle={`${(products || []).filter((p) => p.active).length} active products`}
        actions={biz.canManageAny && (
          <>
            <Link href="/app/products/import"><Button variant="secondary"><Upload className="size-4" /> Import</Button></Link>
            <Link href="/app/products/edit"><Button><Plus className="size-4" /> Add product</Button></Link>
          </>
        )} />

      {(counts.needsPrice > 0 || counts.noPhoto > 0) && (
        <div className="mb-3 flex flex-wrap gap-2">
          {counts.needsPrice > 0 && (
            <button onClick={() => setFilter(filter === "needs_price" ? "active" : "needs_price")}
              className={cx("rounded-full border px-3 py-1 text-sm font-medium", filter === "needs_price" ? "border-amber-500 bg-amber-100 text-amber-900" : "border-amber-300 bg-amber-50 text-amber-900")}>
              {counts.needsPrice} need a selling price
            </button>
          )}
          {counts.noPhoto > 0 && (
            <button onClick={() => setFilter(filter === "no_photo" ? "active" : "no_photo")}
              className={cx("rounded-full border px-3 py-1 text-sm font-medium", filter === "no_photo" ? "border-brand bg-brand-100 text-brand-800" : "border-brand-200 bg-brand-50 text-brand-700")}>
              {counts.noPhoto} without a photo
            </button>
          )}
        </div>
      )}

      <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <Input className="pl-9" placeholder="Search name, brand, model, SKU" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select value={section} onChange={(e) => setSection(e.target.value)} aria-label="Section">
          <option value="all">All sections</option>
          {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        {categories.length > 1 && (
          <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            <option value="all">All categories</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        )}
        <Select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Show">
          <option value="active">Active</option><option value="needs_price">Needs price</option><option value="no_photo">No photo</option>
          <option value="inactive">Inactive</option><option value="all">All</option>
        </Select>
      </div>

      {filter === "no_photo" && list.length > 0 && <p className="mb-2 text-sm text-slate-600">Tap <b>Photo</b> to take a picture of the item with your phone camera.</p>}
      {filter === "needs_price" && list.length > 0 && <p className="mb-2 text-sm text-slate-600">Type the <b>target</b> and <b>minimum</b> selling price and tap Save. Leave minimum empty to use the target. A red box means the price is below cost. You can also export, fill prices in Excel, and re-import with &quot;Update its cost, prices and details&quot;.</p>}

      {products === null ? <Spinner /> : list.length === 0 ? (
        <EmptyState icon={<Package className="size-6" />} title={products.length ? "No products match" : "No products yet"}
          action={biz.canManageAny && !products.length ? <div className="flex gap-2"><Link href="/app/products/import"><Button variant="secondary">Import from Excel</Button></Link><Link href="/app/products/edit"><Button>Add product</Button></Link></div> : undefined}>
          {products.length ? "Try a different search or filter." : "Import your product list from Excel/CSV or add products one by one."}
        </EmptyState>
      ) : (
        <Card>
          <ul className="divide-y divide-slate-100">
            {list.map((p) => {
              const cost = costs[p.id];
              const margin = cost !== undefined && cost > 0 && p.target_price ? Math.round(((p.target_price - cost) / p.target_price) * 100) : null;
              const editable = biz.canManage(p.section_id);
              const priceBlock = p.target_price === null ? <Badge tone="warning">Needs price</Badge> : (
                <span className="tabular whitespace-nowrap text-sm"><b>{fmtMoney(p.target_price, cur)}</b> <span className="text-xs text-slate-500">min {fmtMoney(p.min_price, cur)}</span></span>
              );
              const info = (
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 font-medium leading-snug">{p.name}{p.variant_label ? ` (${p.variant_label})` : ""} {!p.active && <Badge>Inactive</Badge>}</p>
                  <p className="truncate text-xs text-slate-500">{[secName(p.section_id), p.categories?.name, p.brand, p.model, p.sku].filter(Boolean).join(" · ")}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                    {priceBlock}
                    {biz.canViewCosts(p.section_id) && cost !== undefined && (
                      <span className="tabular whitespace-nowrap text-xs text-slate-500">cost {cost > 0 ? fmtMoney(cost, cur) : "not set"}{margin !== null ? ` · ${margin}% margin` : ""}</span>
                    )}
                    <span className={cx("tabular whitespace-nowrap text-xs font-semibold", p.stock_qty === 0 ? "text-red-600" : p.stock_qty <= p.low_stock_threshold ? "text-amber-700" : "text-slate-700")}>{p.stock_qty} in stock</span>
                  </div>
                </div>
              );
              return (
                <li key={p.id} className="px-4 py-3 hover:bg-slate-50">
                  <div className="flex items-start gap-3">
                    <div className="size-12 shrink-0 overflow-hidden rounded-xl"><ProductThumb product={p} iconClass="size-6" /></div>
                    {editable ? <Link href={`/app/products/edit?id=${p.id}`} className="min-w-0 flex-1">{info}</Link> : info}
                    {!p.image_url && <div className="shrink-0"><PhotoButton product={p} onDone={(url) => setImage(p.id, url)} /></div>}
                  </div>
                  {filter === "needs_price" && editable && (
                    <QuickPrice product={p} cost={costs[p.id]} cur={cur} onSaved={(t, m) => setProducts((ps) => (ps || []).map((x) => (x.id === p.id ? { ...x, target_price: t, min_price: m } : x)))} />
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {list.length > 0 && biz.canReport && <div className="mt-3 text-right"><Button variant="ghost" size="sm" onClick={exportCsv}>Export CSV</Button></div>}
    </div>
  );
}

/** Inline price entry used in the "Needs price" list after an import. */
function QuickPrice({ product, cost, cur, onSaved }: { product: Product; cost?: number; cur: string; onSaved: (target: number, min: number) => void }) {
  const toast = useToast();
  const [target, setTarget] = useState("");
  const [min, setMin] = useState("");
  const [busy, setBusy] = useState(false);
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
  const lossT = cost !== undefined && cost > 0 && target !== "" && toMinor(target) < toMinor(cost);
  return (
    <form onSubmit={(e) => { e.preventDefault(); save(); }} className="mt-2 flex items-center gap-2 pl-15">
      <MoneyInput aria-label={`Target price for ${product.name}`} placeholder="Target" value={target} onChange={setTarget} className={cx("h-10 min-w-0 flex-1 text-right text-sm sm:max-w-40", lossT && "border-red-500")} />
      <MoneyInput aria-label={`Minimum price for ${product.name}`} placeholder="Min" value={min} onChange={setMin} className="h-10 min-w-0 flex-1 text-right text-sm sm:max-w-40" />
      <Button size="sm" type="submit" loading={busy}>Save</Button>
    </form>
  );
}

export default function ProductsPage() {
  return <Suspense><ProductsInner /></Suspense>;
}
