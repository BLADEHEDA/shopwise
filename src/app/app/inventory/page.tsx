"use client";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Boxes, Search, History, SlidersHorizontal, Flag, Truck, Check } from "lucide-react";
import { useBiz } from "@/components/biz";
import { useToast } from "@/components/toast";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, MoneyInput, PageHeader, Select, Sheet, Spinner, Stat, Tabs, Textarea } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { fmtMoney, minorToDecimal, toMinor } from "@/lib/money";
import { cx, downloadCsv, errorMessage, fmtDate, fmtDateTime } from "@/lib/format";
import type { Product } from "@/lib/types";

interface Movement { id: string; product_id: string; kind: string; qty_change: number; balance_after: number; reason: string | null; ref_type: string | null; ref_id: string | null; created_at: string; profiles?: { full_name: string | null } | null; products?: { name: string; variant_label: string | null } | null }
interface StockFlag { id: string; product_id: string; kind: "low" | "arrived"; note: string | null; created_at: string; resolved_at: string | null; products?: { name: string } | null; profiles?: { full_name: string | null } | null }
interface Purchase { id: string; purchase_date: string; source: string; currency: string; exchange_rate: number; freight_cost: number; other_costs: number; allocation_method: string; reference: string | null; section_id: string; suppliers?: { name: string } | null; purchase_lines?: { quantity: number; unit_price: number; landed_unit_cost: number; allocated_extra: number; products?: { name: string } | null }[] }

const KIND_LABEL: Record<string, string> = { opening: "Opening stock", purchase: "Purchase received", sale: "Sale", return: "Return", adjustment: "Adjustment", damage: "Damage / loss", transfer: "Transfer", void: "Sale voided", review_accept: "Offline sale accepted" };

type Tab = "levels" | "movements" | "purchases" | "flags";

function InventoryInner() {
  const biz = useBiz();
  const { business, sections } = biz;
  const params = useSearchParams();
  const toast = useToast();
  const cur = business.currency;
  const [tab, setTab] = useState<Tab>("levels");
  const [products, setProducts] = useState<Product[] | null>(null);
  const [costs, setCosts] = useState<Record<string, number>>({});
  const [q, setQ] = useState("");
  const [section, setSection] = useState("all");
  const [lowOnly, setLowOnly] = useState(params.get("filter") === "low");
  const [adjust, setAdjust] = useState<Product | null>(null);
  const [history, setHistory] = useState<Product | null>(null);
  const [flagFor, setFlagFor] = useState<Product | null>(null);

  const load = useCallback(() => {
    const sb = supabase();
    sb.from("products").select("*").eq("business_id", business.id).eq("active", true).order("name").then(({ data }) => setProducts((data || []) as Product[]));
    if (biz.costsAnywhere) sb.from("product_costs").select("product_id, avg_cost").eq("business_id", business.id).then(({ data }) => {
      const m: Record<string, number> = {}; for (const r of (data || []) as { product_id: string; avg_cost: number }[]) m[r.product_id] = r.avg_cost; setCosts(m);
    });
  }, [business.id, biz.costsAnywhere]);
  useEffect(load, [load]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (products || []).filter((p) => (section === "all" || p.section_id === section) && (!lowOnly || p.stock_qty <= p.low_stock_threshold) &&
      (!s || [p.name, p.brand, p.model, p.sku, p.variant_label].some((v) => v && v.toLowerCase().includes(s))));
  }, [products, q, section, lowOnly]);

  const valueRows = list.filter((p) => biz.canViewCosts(p.section_id) && costs[p.id] !== undefined);
  const stockValue = valueRows.reduce((a, p) => a + toMinor(costs[p.id]) * p.stock_qty, 0);
  const retailValue = list.reduce((a, p) => a + toMinor(p.target_price) * p.stock_qty, 0);
  const lowCount = (products || []).filter((p) => p.stock_qty <= p.low_stock_threshold).length;
  const secName = (id: string) => sections.find((s) => s.id === id)?.name || "";

  const tabs: { value: Tab; label: string }[] = [{ value: "levels", label: "Stock levels" }];
  if (biz.canManageAny || biz.canReport) tabs.push({ value: "movements", label: "Movement history" });
  if (biz.costsAnywhere) tabs.push({ value: "purchases", label: "Purchase batches" });
  if (biz.canManageAny) tabs.push({ value: "flags", label: "Staff reports" });

  return (
    <div>
      <PageHeader title="Inventory" subtitle={biz.canManageAny ? "Stock levels, adjustments and history" : "Check stock and report low or arrived items"}
        actions={biz.canManageAny && biz.costsAnywhere && <Link href="/app/inventory/receive"><Button><Truck className="size-4" /> Receive stock</Button></Link>} />
      {tabs.length > 1 && <Tabs value={tab} onChange={setTab} items={tabs} />}

      {tab === "levels" && (
        <>
          {biz.canManageAny && (
            <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Products" value={list.length} />
              <Stat label="Low / out of stock" value={lowCount} tone={lowCount ? "warning" : undefined} />
              <Stat label="Value at target price" value={fmtMoney(minorToDecimal(retailValue), cur)} />
              {biz.costsAnywhere && <Stat label="Stock value (cost)" value={fmtMoney(minorToDecimal(stockValue), cur)} sub="Weighted average landed cost" />}
            </div>
          )}
          <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <Input className="pl-9" placeholder="Search products" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <Select value={section} onChange={(e) => setSection(e.target.value)} aria-label="Section">
              <option value="all">All sections</option>{sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <label className="flex h-11 items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 text-sm font-medium">
              <input type="checkbox" className="size-4 accent-brand" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> Low stock only
            </label>
          </div>
          {products === null ? <Spinner /> : list.length === 0 ? (
            <EmptyState icon={<Boxes className="size-6" />} title={lowOnly ? "Nothing is low on stock" : "No products"}>{lowOnly ? "Every product is above its alert level." : "Add products first."}</EmptyState>
          ) : (
            <Card>
              <ul className="divide-y divide-slate-100">
                {list.map((p) => {
                  const low = p.stock_qty <= p.low_stock_threshold;
                  const manage = biz.canManage(p.section_id);
                  return (
                    <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{p.name}{p.variant_label ? ` (${p.variant_label})` : ""}</p>
                        <p className="text-xs text-slate-500">{secName(p.section_id)} · alert at {p.low_stock_threshold}{biz.canViewCosts(p.section_id) && costs[p.id] !== undefined ? ` · cost ${fmtMoney(costs[p.id], cur)}` : ""}</p>
                      </div>
                      <div className="text-right">
                        <p className={cx("tabular text-lg font-bold", p.stock_qty === 0 ? "text-red-600" : low ? "text-amber-700" : "text-ink")}>{p.stock_qty}</p>
                        {low && <Badge tone={p.stock_qty === 0 ? "danger" : "warning"}>{p.stock_qty === 0 ? "Out" : "Low"}</Badge>}
                      </div>
                      <div className="flex gap-1">
                        {manage && <Button size="sm" variant="secondary" onClick={() => setAdjust(p)} aria-label={`Adjust ${p.name}`}><SlidersHorizontal className="size-4" /><span className="hidden sm:inline">Adjust</span></Button>}
                        {(manage || biz.canReport) && <Button size="sm" variant="ghost" onClick={() => setHistory(p)} aria-label={`History of ${p.name}`}><History className="size-4" /></Button>}
                        {!manage && <Button size="sm" variant="secondary" onClick={() => setFlagFor(p)}><Flag className="size-4" /> Report</Button>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
          {biz.canManageAny && list.length > 0 && (
            <div className="mt-3 text-right">
              <Button variant="ghost" size="sm" onClick={() => downloadCsv(`stock-${new Date().toISOString().slice(0, 10)}.csv`, [
                ["section", "product", "variant", "stock", "low_stock_threshold", ...(biz.costsAnywhere ? ["avg_cost", "stock_value"] : [])],
                ...list.map((p) => [secName(p.section_id), p.name, p.variant_label, p.stock_qty, p.low_stock_threshold,
                  ...(biz.costsAnywhere ? (biz.canViewCosts(p.section_id) ? [costs[p.id] ?? "", minorToDecimal(toMinor(costs[p.id] ?? 0) * p.stock_qty)] : ["", ""]) : [])]),
              ])}>Export CSV</Button>
            </div>
          )}
        </>
      )}

      {tab === "movements" && <Movements />}
      {tab === "purchases" && <Purchases cur={cur} />}
      {tab === "flags" && <Flags />}

      {adjust && <AdjustSheet product={adjust} onClose={() => setAdjust(null)} onDone={() => { setAdjust(null); load(); toast("Stock updated"); }} />}
      {history && <HistorySheet product={history} onClose={() => setHistory(null)} />}
      {flagFor && <FlagSheet product={flagFor} onClose={() => setFlagFor(null)} onDone={() => { setFlagFor(null); toast("Thanks, the manager has been notified"); }} />}
    </div>
  );
}

function AdjustSheet({ product, onClose, onDone }: { product: Product; onClose: () => void; onDone: () => void }) {
  const biz = useBiz();
  const [kind, setKind] = useState<"adjustment" | "damage" | "return" | "opening">("adjustment");
  const [direction, setDirection] = useState<"add" | "remove">("add");
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const n = parseInt(qty || "0", 10) || 0;
  const change = kind === "damage" ? -n : kind === "adjustment" && direction === "remove" ? -n : n;
  const after = product.stock_qty + change;
  const showCost = change > 0 && biz.canViewCosts(product.section_id) && kind !== "return";

  async function save() {
    setErr(null);
    if (!n) return setErr("Enter a quantity.");
    if (after < 0) return setErr("Stock can't go below zero.");
    if (!reason.trim() && kind !== "opening") return setErr("Give a reason. It's kept in the stock history.");
    setBusy(true);
    const { error } = await supabase().rpc("adjust_stock", { p_product: product.id, p_qty_change: change, p_kind: kind, p_reason: reason || null, p_unit_cost: showCost && cost ? minorToDecimal(toMinor(cost)) : null });
    setBusy(false);
    if (error) setErr(errorMessage(error)); else onDone();
  }

  return (
    <Sheet open onClose={onClose} title={`Adjust: ${product.name}`} footer={<Button block size="lg" loading={busy} onClick={save}>Save adjustment</Button>}>
      <div className="space-y-3">
        <Field label="Type">
          <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="adjustment">Count correction</option>
            <option value="damage">Damage / loss / theft</option>
            <option value="return">Customer return (back to stock)</option>
            <option value="opening">Opening stock</option>
          </Select>
        </Field>
        {kind === "adjustment" && (
          <div className="grid grid-cols-2 gap-2">
            {(["add", "remove"] as const).map((d) => (
              <button key={d} onClick={() => setDirection(d)} className={cx("rounded-xl border p-2.5 text-sm font-semibold", direction === d ? "border-brand bg-brand-50 text-brand-700" : "border-slate-300")}>{d === "add" ? "Add to stock" : "Remove from stock"}</button>
            ))}
          </div>
        )}
        <Field label="Quantity"><Input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} /></Field>
        {showCost && <Field label="Unit cost (optional)" hint="Updates the weighted average cost"><MoneyInput value={cost} onChange={setCost} /></Field>}
        <Field label="Reason"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Physical count on Saturday" /></Field>
        <div className="rounded-xl bg-slate-50 p-3 text-sm">Stock: <b>{product.stock_qty}</b> → <b className={after < 0 ? "text-red-600" : ""}>{after}</b></div>
        {err && <Alert tone="danger">{err}</Alert>}
      </div>
    </Sheet>
  );
}

function HistorySheet({ product, onClose }: { product: Product; onClose: () => void }) {
  const { business } = useBiz();
  const [rows, setRows] = useState<Movement[] | null>(null);
  useEffect(() => {
    supabase().from("stock_movements").select("*, profiles(full_name)").eq("product_id", product.id).order("created_at", { ascending: false }).limit(100)
      .then(({ data }) => setRows((data || []) as Movement[]));
  }, [product.id]);
  return (
    <Sheet open onClose={onClose} title={`History: ${product.name}`} wide>
      {rows === null ? <Spinner /> : rows.length === 0 ? <p className="py-6 text-center text-sm text-slate-500">No stock movements yet.</p> : (
        <ul className="divide-y divide-slate-100">
          {rows.map((m) => <MovementRow key={m.id} m={m} tz={business.timezone} />)}
        </ul>
      )}
    </Sheet>
  );
}

function MovementRow({ m, tz, showProduct }: { m: Movement; tz: string; showProduct?: boolean }) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{showProduct && m.products ? `${m.products.name}${m.products.variant_label ? ` (${m.products.variant_label})` : ""} · ` : ""}{KIND_LABEL[m.kind] || m.kind}</p>
        <p className="truncate text-xs text-slate-500">
          {fmtDateTime(m.created_at, tz)} · {m.profiles?.full_name || "—"}{m.reason ? ` · ${m.reason}` : ""}
          {m.ref_type === "sale" && m.ref_id ? <> · <Link className="text-brand underline" href={`/app/sales/view?id=${m.ref_id}`}>receipt</Link></> : null}
        </p>
      </div>
      <span className={cx("tabular w-14 text-right font-semibold", m.qty_change > 0 ? "text-emerald-700" : "text-red-700")}>{m.qty_change > 0 ? "+" : ""}{m.qty_change}</span>
      <span className="tabular w-12 text-right text-sm text-slate-500">= {m.balance_after}</span>
    </li>
  );
}

function Movements() {
  const { business } = useBiz();
  const [rows, setRows] = useState<Movement[] | null>(null);
  const [kind, setKind] = useState("all");
  useEffect(() => {
    let q = supabase().from("stock_movements").select("*, profiles(full_name), products(name, variant_label)").eq("business_id", business.id).order("created_at", { ascending: false }).limit(200);
    if (kind !== "all") q = q.eq("kind", kind);
    q.then(({ data }) => setRows((data || []) as Movement[]));
  }, [business.id, kind]);
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm text-slate-500">Every change in quantity is recorded here and can&apos;t be edited.</p>
        <Select className="w-48" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Movement type">
          <option value="all">All types</option>{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </div>
      {rows === null ? <Spinner /> : rows.length === 0 ? <p className="py-6 text-center text-sm text-slate-500">No movements.</p> : (
        <ul className="divide-y divide-slate-100">{rows.map((m) => <MovementRow key={m.id} m={m} tz={business.timezone} showProduct />)}</ul>
      )}
    </Card>
  );
}

function Purchases({ cur }: { cur: string }) {
  const { business, sections } = useBiz();
  const [rows, setRows] = useState<Purchase[] | null>(null);
  useEffect(() => {
    supabase().from("purchases").select("*, suppliers(name), purchase_lines(quantity, unit_price, landed_unit_cost, allocated_extra, products(name))")
      .eq("business_id", business.id).order("created_at", { ascending: false }).limit(100).then(({ data }) => setRows((data || []) as Purchase[]));
  }, [business.id]);
  if (rows === null) return <Spinner />;
  if (!rows.length) return <EmptyState icon={<Truck className="size-6" />} title="No purchases recorded" action={<Link href="/app/inventory/receive"><Button>Receive stock</Button></Link>}>Record purchases to keep batch costs and compare China vs local suppliers.</EmptyState>;
  return (
    <div className="space-y-3">
      {rows.map((p) => (
        <Card key={p.id} className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-semibold">{p.suppliers?.name || "Unknown supplier"} <Badge tone={p.source === "import" ? "brand" : "neutral"}>{p.source === "import" ? "Imported" : "Local"}</Badge></p>
              <p className="text-xs text-slate-500">{fmtDate(p.purchase_date)} · {sections.find((s) => s.id === p.section_id)?.name}{p.reference ? ` · ref ${p.reference}` : ""}{p.currency !== business.currency ? ` · ${p.currency} @ ${p.exchange_rate}` : ""}</p>
            </div>
            <p className="text-right text-xs text-slate-500">Freight {fmtMoney(p.freight_cost, cur)} · Other {fmtMoney(p.other_costs, cur)}<br />Allocated by {p.allocation_method}</p>
          </div>
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-xs text-slate-500"><tr><th className="py-1">Item</th><th className="text-right">Qty</th><th className="text-right">Unit price</th><th className="text-right">+ Extra</th><th className="text-right">Landed / unit</th></tr></thead>
            <tbody>
              {(p.purchase_lines || []).map((l, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="py-1.5">{l.products?.name}</td>
                  <td className="tabular text-right">{l.quantity}</td>
                  <td className="tabular text-right">{l.unit_price} {p.currency === business.currency ? "" : p.currency}</td>
                  <td className="tabular text-right">{fmtMoney(l.allocated_extra, cur)}</td>
                  <td className="tabular text-right font-semibold">{fmtMoney(l.landed_unit_cost, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  );
}

function Flags() {
  const { business } = useBiz();
  const toast = useToast();
  const [rows, setRows] = useState<StockFlag[] | null>(null);
  const load = useCallback(() => {
    supabase().from("stock_flags").select("*, products(name), profiles!stock_flags_created_by_fkey(full_name)").eq("business_id", business.id).is("resolved_at", null).order("created_at", { ascending: false })
      .then(({ data }) => setRows((data || []) as StockFlag[]));
  }, [business.id]);
  useEffect(load, [load]);
  if (rows === null) return <Spinner />;
  if (!rows.length) return <EmptyState icon={<Flag className="size-6" />} title="No open reports">Staff can report low stock or that new stock has arrived from the Inventory screen.</EmptyState>;
  return (
    <Card>
      <ul className="divide-y divide-slate-100">
        {rows.map((f) => (
          <li key={f.id} className="flex items-center gap-3 px-4 py-3">
            <Badge tone={f.kind === "low" ? "warning" : "info"}>{f.kind === "low" ? "Low stock" : "Arrived"}</Badge>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{f.products?.name}</p>
              <p className="truncate text-xs text-slate-500">{f.profiles?.full_name} · {fmtDateTime(f.created_at, business.timezone)}{f.note ? ` · ${f.note}` : ""}</p>
            </div>
            <Button size="sm" variant="secondary" onClick={async () => { const { error } = await supabase().rpc("resolve_stock_flag", { p_flag: f.id }); if (error) toast(errorMessage(error), "error"); else load(); }}><Check className="size-4" /> Done</Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function FlagSheet({ product, onClose, onDone }: { product: Product; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<"low" | "arrived">("low");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    const { error } = await supabase().rpc("flag_stock", { p_product: product.id, p_kind: kind, p_note: note || null });
    setBusy(false);
    if (error) setErr(errorMessage(error)); else onDone();
  }
  return (
    <Sheet open onClose={onClose} title={`Report: ${product.name}`} footer={<Button block size="lg" loading={busy} onClick={save}>Send report</Button>}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          {(["low", "arrived"] as const).map((k) => (
            <button key={k} onClick={() => setKind(k)} className={cx("rounded-xl border p-3 text-sm font-semibold", kind === k ? "border-brand bg-brand-50 text-brand-700" : "border-slate-300")}>{k === "low" ? "Running low" : "New stock arrived"}</button>
          ))}
        </div>
        <Field label="Note (optional)"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={kind === "arrived" ? "e.g. 2 boxes delivered by supplier" : "e.g. Only display unit left"} /></Field>
        {err && <Alert tone="danger">{err}</Alert>}
        <p className="text-xs text-slate-500">Staff don&apos;t change stock numbers directly. The manager will check and update the stock.</p>
      </div>
    </Sheet>
  );
}

export default function InventoryPage() {
  return <Suspense><InventoryInner /></Suspense>;
}
