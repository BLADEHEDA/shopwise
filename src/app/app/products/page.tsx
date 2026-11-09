"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Package, Plus, Search, Upload } from "lucide-react";
import { useBiz } from "@/components/biz";
import { Badge, Button, Card, EmptyState, Input, PageHeader, Select, Spinner } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { fmtMoney } from "@/lib/money";
import { cx, downloadCsv } from "@/lib/format";
import type { Product } from "@/lib/types";

export default function ProductsPage() {
  const biz = useBiz();
  const { business, sections } = biz;
  const [products, setProducts] = useState<Product[] | null>(null);
  const [costs, setCosts] = useState<Record<string, number>>({});
  const [q, setQ] = useState("");
  const [section, setSection] = useState("all");
  const [status, setStatus] = useState<"active" | "inactive" | "all">("active");
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
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (products || []).filter((p) =>
      (section === "all" || p.section_id === section) &&
      (status === "all" || (status === "active" ? p.active : !p.active)) &&
      (!s || [p.name, p.brand, p.model, p.sku, p.barcode, p.variant_label, p.categories?.name].some((v) => v && v.toLowerCase().includes(s))));
  }, [products, q, section, status]);

  function exportCsv() {
    const header = ["section", "category", "name", "variant_label", "brand", "model", "sku", "target_price", "min_price", "stock", "low_stock_threshold", "active"];
    if (biz.costsAnywhere) header.push("avg_cost");
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
      <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <Input className="pl-9" placeholder="Search name, brand, model, SKU" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select value={section} onChange={(e) => setSection(e.target.value)} aria-label="Section">
          <option value="all">All sections</option>
          {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status">
          <option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option>
        </Select>
      </div>

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
              const margin = cost !== undefined && cost > 0 ? Math.round(((p.target_price - cost) / p.target_price) * 100) : null;
              const editable = biz.canManage(p.section_id);
              const Row = (
                <div className="flex items-center gap-3 px-4 py-3">
                  <div className="size-12 shrink-0 overflow-hidden rounded-xl bg-brand-50">
                    {p.image_url
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={p.image_url} alt="" className="size-full object-cover" />
                      : <div className="grid size-full place-items-center font-bold text-brand-300">{p.name.charAt(0)}</div>}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{p.name}{p.variant_label ? ` (${p.variant_label})` : ""} {!p.active && <Badge>Inactive</Badge>}</p>
                    <p className="truncate text-xs text-slate-500">{[secName(p.section_id), p.categories?.name, p.brand, p.model, p.sku].filter(Boolean).join(" · ")}</p>
                  </div>
                  <div className="text-right text-sm">
                    <p className="tabular font-semibold">{fmtMoney(p.target_price, cur)}</p>
                    <p className="tabular text-xs text-slate-500">min {fmtMoney(p.min_price, cur)}</p>
                    {biz.canViewCosts(p.section_id) && cost !== undefined && (
                      <p className="tabular text-xs text-slate-500">cost {fmtMoney(cost, cur)}{margin !== null ? ` · ${margin}%` : ""}</p>
                    )}
                  </div>
                  <div className="w-16 text-right">
                    <span className={cx("tabular text-sm font-semibold", p.stock_qty === 0 ? "text-red-600" : p.stock_qty <= p.low_stock_threshold ? "text-amber-700" : "text-ink")}>{p.stock_qty}</span>
                    <p className="text-[11px] text-slate-500">in stock</p>
                  </div>
                </div>
              );
              return <li key={p.id}>{editable ? <Link href={`/app/products/edit?id=${p.id}`} className="block hover:bg-slate-50">{Row}</Link> : Row}</li>;
            })}
          </ul>
        </Card>
      )}
      {list.length > 0 && biz.canReport && <div className="mt-3 text-right"><Button variant="ghost" size="sm" onClick={exportCsv}>Export CSV</Button></div>}
    </div>
  );
}
