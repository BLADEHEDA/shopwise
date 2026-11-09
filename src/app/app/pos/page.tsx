"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Minus, Plus, Trash2, ShoppingCart, ChevronLeft, ShieldCheck, Hourglass, CircleX, WifiOff, Package, X, Check } from "lucide-react";
import { useBiz } from "@/components/biz";
import { useToast } from "@/components/toast";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, MoneyInput, Sheet, Spinner, Textarea } from "@/components/ui";
import { ShiftCard } from "@/components/shift-card";
import { ProductThumb } from "@/components/product-photo";
import { supabase } from "@/lib/supabase";
import { cacheCatalogue, cachedCatalogue, db, queueSale } from "@/lib/offline";
import { fmtMinor, fmtMoney, minorToDecimal, toMinor, type Minor } from "@/lib/money";
import { cx, errorMessage, isNetworkError, uuid } from "@/lib/format";
import type { PaymentMethod, Product } from "@/lib/types";

interface Override { id: string; status: "pending" | "approved" | "rejected" | "cancelled"; approved_price: number | null; note?: string | null }
interface Line { key: string; product: Product; qty: number; price: string; override?: Override }
interface Pay { key: string; method_id: string; amount: string; reference: string; label: string }

function lineState(l: Line): { ok: boolean; reason?: string; belowMin: boolean } {
  const p = toMinor(l.price);
  if (Number.isNaN(p) || p <= 0) return { ok: false, reason: "Enter a price", belowMin: false };
  if (l.qty <= 0) return { ok: false, reason: "Quantity must be at least 1", belowMin: false };
  const min = toMinor(l.product.min_price);
  if (p < min) {
    if (l.override?.status === "approved" && toMinor(l.override.approved_price ?? 0) === p) return { ok: true, belowMin: true };
    return { ok: false, reason: `Below minimum (${fmtMoney(l.product.min_price)})`, belowMin: true };
  }
  return { ok: true, belowMin: false };
}

export default function POS() {
  const biz = useBiz();
  const { business, online, shift } = biz;
  const router = useRouter();
  const toast = useToast();
  const cur = business.currency;

  const [products, setProducts] = useState<Product[] | null>(null);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [fromCache, setFromCache] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [section, setSection] = useState<string>("all");
  const [lines, setLines] = useState<Line[]>([]);
  const [step, setStep] = useState<"browse" | "cart" | "pay">("browse");
  const [customer, setCustomer] = useState({ name: "", phone: "", note: "" });
  const [pays, setPays] = useState<Pay[]>([]);
  const [txId, setTxId] = useState(uuid());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ovLine, setOvLine] = useState<Line | null>(null);
  const [ovReason, setOvReason] = useState("");
  const [offlineDone, setOfflineDone] = useState<{ ref: string; lines: { name: string; qty: number; total: Minor }[]; total: Minor; paid: Minor; customer: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const handledOverrides = useRef(new Set<string>());

  // ---------------------------------------------------------------- data
  const load = useCallback(async () => {
    const sb = supabase();
    try {
      const [p, m] = await Promise.all([
        sb.from("products").select("*, categories(name)").eq("business_id", business.id).eq("active", true).order("name"),
        sb.from("payment_methods").select("*").eq("business_id", business.id).eq("active", true).order("sort"),
      ]);
      if (p.error || m.error) throw p.error || m.error;
      setProducts(p.data as Product[]);
      setMethods(m.data as PaymentMethod[]);
      setFromCache(null);
      cacheCatalogue(business.id, p.data as Product[], m.data as PaymentMethod[]);
    } catch {
      const c = await cachedCatalogue(business.id);
      setProducts(c.products.filter((x) => x.active));
      setMethods(c.methods.filter((x) => x.active).sort((a, b) => a.sort - b.sort));
      setFromCache(c.cachedAt || "never");
    }
  }, [business.id]);
  useEffect(() => { load(); }, [load, online]);

  const mine = useMemo(() => (products || []).filter((p) => biz.hasSection(p.section_id)), [products, biz]);
  // products imported without a selling price can't be sold until a price is set
  const sellable = useMemo(() => mine.filter((p) => p.target_price !== null && p.min_price !== null), [mine]);
  const unpriced = mine.length - sellable.length;
  const visible = useMemo(() => {
    const s = q.trim().toLowerCase();
    return sellable.filter((p) => (section === "all" || p.section_id === section) && (!s ||
      [p.name, p.brand, p.model, p.sku, p.barcode, p.variant_label, p.categories?.name].some((v) => v && v.toLowerCase().includes(s))));
  }, [sellable, q, section]);

  // ---------------------------------------------------------------- cart
  const add = (p: Product) => {
    setLines((ls) => {
      const ex = ls.find((l) => l.product.id === p.id && !l.override);
      if (ex) return ls.map((l) => (l === ex ? { ...l, qty: l.qty + 1 } : l));
      return [...ls, { key: uuid(), product: p, qty: 1, price: String(p.target_price) }];
    });
    setErr(null);
  };
  const update = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const remove = (key: string) => setLines((ls) => ls.filter((l) => l.key !== key));

  const total: Minor = lines.reduce((s, l) => s + (Number.isNaN(toMinor(l.price)) ? 0 : toMinor(l.price) * l.qty), 0);
  const items = lines.reduce((s, l) => s + l.qty, 0);
  const qtyInCart = (id: string) => lines.filter((l) => l.product.id === id).reduce((s, l) => s + l.qty, 0);
  const allValid = lines.length > 0 && lines.every((l) => lineState(l).ok);
  const stockProblems = lines.filter((l) => qtyInCart(l.product.id) > l.product.stock_qty);

  const paid: Minor = pays.reduce((s, p) => s + (Number.isNaN(toMinor(p.amount)) ? 0 : toMinor(p.amount)), 0);
  const balance = total - paid;
  const needShift = business.require_shift && !shift;

  // poll pending override requests
  useEffect(() => {
    const pending = lines.filter((l) => l.override?.status === "pending");
    if (!pending.length) return;
    const t = setInterval(async () => {
      const { data } = await supabase().from("price_override_requests").select("id, status, approved_price, decision_note").in("id", pending.map((l) => l.override!.id));
      for (const r of (data || []) as { id: string; status: Override["status"]; approved_price: number | null; decision_note: string | null }[]) {
        if (r.status === "pending" || handledOverrides.current.has(r.id)) continue;
        handledOverrides.current.add(r.id);
        const line = pending.find((l) => l.override!.id === r.id);
        if (r.status === "approved") toast(`Approved: ${line?.product.name} at ${fmtMoney(r.approved_price, cur)}`);
        else toast(`Price request for ${line?.product.name} was declined${r.decision_note ? `: ${r.decision_note}` : ""}`, "error");
        setLines((ls) => ls.map((l) => {
          if (l.override?.id !== r.id) return l;
          if (r.status === "approved") return { ...l, price: String(r.approved_price), override: { id: r.id, status: "approved", approved_price: r.approved_price, note: r.decision_note } };
          return { ...l, price: String(l.product.target_price), override: { id: r.id, status: "rejected", approved_price: null, note: r.decision_note } };
        }));
      }
    }, 4000);
    return () => clearInterval(t);
  }, [lines, toast, cur]);

  async function requestOverride() {
    if (!ovLine) return;
    const { data, error } = await supabase().rpc("request_price_override", {
      p_business: business.id, p_product: ovLine.product.id, p_price: minorToDecimal(toMinor(ovLine.price)),
      p_quantity: ovLine.qty, p_reason: ovReason || null,
    });
    if (error) { toast(errorMessage(error), "error"); return; }
    update(ovLine.key, { override: { id: data as string, status: "pending", approved_price: null } });
    setOvLine(null); setOvReason("");
    toast("Request sent to the owner. Keep this screen open.");
  }

  function goPay() {
    if (!allValid) { setErr("Fix the highlighted lines first."); return; }
    setErr(null);
    // nothing pre-filled: the cashier enters what was actually received
    setStep("pay");
  }

  // each method once; only "Other" (Bank transfer, Bitcoin…) can repeat, each with its own name
  const isOther = (m?: PaymentMethod) => !!m && m.name === "Other";
  const used = (m: PaymentMethod) => !isOther(m) && pays.some((p) => p.method_id === m.id);
  function addPay(m: PaymentMethod) {
    if (used(m)) return;
    setPays((ps) => [...ps, { key: uuid(), method_id: m.id, amount: "", reference: "", label: "" }]);
  }
  const setPay = (key: string, ch: Partial<Pay>) => setPays((ps) => ps.map((x) => (x.key === key ? { ...x, ...ch } : x)));
  const plain = (m: Minor) => minorToDecimal(m).replace(/\.00$/, "");

  function reset() {
    setLines([]); setPays([]); setCustomer({ name: "", phone: "", note: "" }); setStep("browse"); setTxId(uuid()); setErr(null); setQ("");
  }

  async function complete() {
    setErr(null);
    if (!allValid) { setErr("Some cart lines need attention."); setStep("cart"); return; }
    if (paid > total) { setErr("Payments are more than the total. Enter what the customer actually paid (give change separately)."); return; }
    if (pays.some((p) => toMinor(p.amount) <= 0 || Number.isNaN(toMinor(p.amount)))) { setErr("Remove empty payment lines or enter an amount."); return; }
    if (pays.some((p) => isOther(methods.find((m) => m.id === p.method_id)) && !p.label.trim())) { setErr('Say what each "Other" payment was (for example Bank transfer).'); return; }
    if (balance > 0 && !customer.name.trim()) { setErr("This sale has a balance due. Enter the customer's name (and phone) so you can follow up."); return; }

    const payload = {
      business_id: business.id,
      client_tx_id: txId,
      customer_name: customer.name.trim() || null,
      customer_phone: customer.phone.trim() || null,
      note: customer.note.trim() || null,
      sold_at: new Date().toISOString(),
      lines: lines.map((l) => ({ product_id: l.product.id, quantity: l.qty, unit_price: minorToDecimal(toMinor(l.price)), override_id: l.override?.status === "approved" ? l.override.id : null })),
      payments: pays.map((p) => ({ method_id: p.method_id, amount: minorToDecimal(toMinor(p.amount)), reference: p.reference.trim() || null, label: p.label.trim() || null })),
    };

    const goOffline = async () => {
      if (lines.some((l) => lineState(l).belowMin)) { setErr("Sales with an owner-approved price can't be queued offline. Reconnect to finish this sale."); return; }
      if (needShift) { setErr("Clock in before recording sales."); return; }
      await queueSale({
        client_tx_id: txId, business_id: business.id, payload, created_at: new Date().toISOString(),
        display: { lines: lines.map((l) => ({ name: l.product.name, quantity: l.qty, unit_price: l.price })), total: minorToDecimal(total), paid: minorToDecimal(paid), customer: customer.name || undefined },
      });
      // reflect the sale in the local stock so later offline sales see it
      for (const l of lines) {
        const left = l.product.stock_qty - l.qty;
        try { await db().products.update(l.product.id, { stock_qty: left }); } catch {}
      }
      setProducts((ps) => (ps || []).map((p) => { const used = qtyInCart(p.id); return used ? { ...p, stock_qty: p.stock_qty - used } : p; }));
      setOfflineDone({ ref: txId, lines: lines.map((l) => ({ name: l.product.name, qty: l.qty, total: toMinor(l.price) * l.qty })), total, paid, customer: customer.name });
      reset();
    };

    if (!navigator.onLine) { await goOffline(); return; }
    setBusy(true);
    const { data, error } = await supabase().rpc("finalize_sale", { p: payload });
    setBusy(false);
    if (error) {
      if (isNetworkError(error)) { await goOffline(); return; }
      setErr(errorMessage(error));
      load(); // refresh stock/prices in case they changed
      return;
    }
    const res = data as { sale_id: string };
    reset();
    load();
    router.push(`/app/sales/view?id=${res.sale_id}&new=1`);
  }

  // ---------------------------------------------------------------- ui
  if (products === null) return <Spinner label="Loading products…" />;

  if (offlineDone) {
    return (
      <div className="mx-auto max-w-md space-y-4">
        <Alert tone="warning" title="Saved offline: pending sync">
          This sale is stored on this phone and will sync automatically when you&apos;re back online. It gets a receipt number once it syncs. If stock or prices changed meanwhile, the owner will review it.
        </Alert>
        <Card className="p-5">
          <p className="text-center text-lg font-bold">{business.name}</p>
          <p className="text-center text-xs text-slate-500">Provisional receipt · ref {offlineDone.ref.slice(0, 8).toUpperCase()}{offlineDone.customer ? ` · ${offlineDone.customer}` : ""}</p>
          <ul className="my-4 space-y-1 text-sm">
            {offlineDone.lines.map((l, i) => <li key={i} className="flex justify-between gap-2"><span>{l.qty} × {l.name}</span><span className="tabular">{fmtMinor(l.total, cur)}</span></li>)}
          </ul>
          <div className="space-y-1 border-t border-dashed border-slate-300 pt-3 text-sm">
            <div className="flex justify-between font-bold"><span>Total</span><span className="tabular">{fmtMinor(offlineDone.total, cur)}</span></div>
            <div className="flex justify-between"><span>Paid</span><span className="tabular">{fmtMinor(offlineDone.paid, cur)}</span></div>
            {offlineDone.total > offlineDone.paid && <div className="flex justify-between font-semibold text-amber-700"><span>Balance due</span><span className="tabular">{fmtMinor(offlineDone.total - offlineDone.paid, cur)}</span></div>}
          </div>
        </Card>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => router.push("/app/sales?tab=queue")}>Offline queue</Button>
          <Button onClick={() => setOfflineDone(null)}><ShoppingCart className="size-4" /> Next sale</Button>
        </div>
      </div>
    );
  }

  const cartPanel = (
    <CartPanel
      lines={lines} total={total} cur={cur} onQty={(k, n) => update(k, { qty: n })} onPrice={(k, v) => update(k, { price: v, override: undefined })}
      onRemove={remove} onRequest={(l) => { setOvLine(l); setOvReason(""); }} onCancelOverride={async (l) => {
        if (l.override) await supabase().rpc("cancel_price_override", { p_request: l.override.id });
        update(l.key, { override: undefined, price: String(l.product.target_price) });
      }} qtyInCart={qtyInCart} online={online}
    />
  );

  if (step === "pay") {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <button onClick={() => setStep("cart")} className="inline-flex items-center gap-1 text-sm font-medium text-slate-600"><ChevronLeft className="size-4" /> Back to cart</button>
        <Card className="p-5 text-center">
          <p className="text-sm text-slate-500">Total to pay</p>
          <p className="tabular text-4xl font-bold">{fmtMinor(total, cur)}</p>
          <p className="mt-1 text-sm text-slate-500">{items} item{items === 1 ? "" : "s"}</p>
        </Card>

        <Card className="space-y-3 p-4">
          <div>
            <h2 className="font-semibold">How did the customer pay?</h2>
            <p className="text-sm text-slate-500">Tap each method used and enter the amount received. Part payment is allowed.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {methods.map((m) => {
              const on = used(m);
              return (
                <button key={m.id} type="button" onClick={() => addPay(m)} disabled={on} aria-pressed={on}
                  className={cx("inline-flex h-10 items-center gap-1.5 rounded-xl border px-3 text-sm font-semibold transition",
                    on ? "cursor-default border-emerald-300 bg-emerald-50 text-emerald-700" : "border-slate-300 bg-white text-slate-800 hover:border-brand hover:text-brand")}>
                  {on ? <Check className="size-4" /> : <Plus className="size-4" />} {isOther(m) ? "Other (bank, crypto…)" : m.name}
                </button>
              );
            })}
          </div>
          {pays.map((p) => {
            const m = methods.find((x) => x.id === p.method_id);
            const other = isOther(m);
            const mine = Number.isNaN(toMinor(p.amount)) ? 0 : toMinor(p.amount);
            const restHere = Math.max(0, balance + mine);
            return (
              <div key={p.key} className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{other ? "Other payment" : m?.name}</span>
                  <div className="flex items-center gap-1">
                    {restHere > 0 && restHere !== mine && (
                      <button type="button" onClick={() => setPay(p.key, { amount: plain(restHere) })} className="rounded-lg px-2 py-1 text-xs font-semibold text-brand hover:bg-brand-50">
                        Rest: {fmtMinor(restHere, cur)}
                      </button>
                    )}
                    <button onClick={() => setPays(pays.filter((x) => x.key !== p.key))} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100" aria-label={`Remove ${other ? p.label || "Other" : m?.name} payment`}><X className="size-4" /></button>
                  </div>
                </div>
                {other && (
                  <Input className="mt-2" placeholder="What payment? e.g. Bank transfer, Bitcoin, Card" value={p.label} aria-label="Other payment name"
                    onChange={(e) => setPay(p.key, { label: e.target.value })} />
                )}
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <MoneyInput aria-label={`${other ? "Other" : m?.name} amount`} value={p.amount} onChange={(v) => setPay(p.key, { amount: v })} placeholder="Amount received" autoFocus={!other} />
                  {m?.kind !== "cash"
                    ? <Input placeholder="Transaction ID (optional)" value={p.reference} onChange={(e) => setPay(p.key, { reference: e.target.value })} />
                    : <div />}
                </div>
              </div>
            );
          })}
          <div className="space-y-1 rounded-xl bg-slate-50 p-3 text-[15px]">
            <div className="flex justify-between"><span>Total</span><span className="tabular font-semibold">{fmtMinor(total, cur)}</span></div>
            <div className="flex justify-between"><span>Paid now</span><span className="tabular font-semibold">{fmtMinor(paid, cur)}</span></div>
            <div className={cx("flex justify-between border-t border-slate-200 pt-1 text-lg font-bold", balance > 0 ? "text-amber-700" : balance < 0 ? "text-red-700" : "text-emerald-700")}>
              <span>{balance > 0 ? "Balance due" : balance < 0 ? "Overpaid" : "Fully paid"}</span>
              <span className="tabular">{fmtMinor(Math.abs(balance), cur)}</span>
            </div>
          </div>
          {balance > 0 && <Alert tone="warning">{paid > 0 ? <>This will be saved as a <b>part payment</b>.</> : <>Nothing paid yet: this will be saved as <b>unpaid</b>.</>} The customer owes {fmtMinor(balance, cur)}. Find it later under Sales → Part paid / owing to collect the rest.</Alert>}
        </Card>

        <Card className="space-y-3 p-4">
          <h2 className="font-semibold">Customer {balance > 0 ? <span className="text-red-600">*</span> : <span className="text-sm font-normal text-slate-500">(optional)</span>}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input placeholder="Name" value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} />
            <Input placeholder="Phone" inputMode="tel" value={customer.phone} onChange={(e) => setCustomer({ ...customer, phone: e.target.value })} />
          </div>
          <Input placeholder="Note (optional)" value={customer.note} onChange={(e) => setCustomer({ ...customer, note: e.target.value })} />
        </Card>

        {!online && <Alert tone="warning" title="You're offline">This sale will be saved on this phone and marked <b>pending</b> until it syncs.</Alert>}
        {err && <Alert tone="danger">{err}</Alert>}
        <Button size="lg" block onClick={complete} loading={busy} variant="success" className="text-lg">
          {!online ? `Save sale offline · ${fmtMinor(total, cur)}` : balance > 0 ? `Save part payment · owes ${fmtMinor(balance, cur)}` : `Complete sale · ${fmtMinor(total, cur)}`}
        </Button>
      </div>
    );
  }

  return (
    <div className="lg:grid lg:grid-cols-[1fr_380px] lg:gap-6">
      <div className="min-w-0">
        {needShift && <div className="mb-3"><ShiftCard compact /></div>}
        {fromCache && (
          <Alert tone="warning" className="mb-3" title="Offline: showing saved products">
            Prices and stock were last updated {fromCache === "never" ? "never" : new Date(fromCache).toLocaleString()}. Sales will sync when you reconnect.
          </Alert>
        )}
        <div className="sticky top-[57px] z-20 -mx-4 bg-[#f5f6f8] px-4 pb-3 pt-1 lg:static lg:mx-0 lg:px-0">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-slate-400" />
            <Input ref={searchRef} className="h-12 pl-10 text-base" placeholder="Search name, brand, model or scan barcode" value={q}
              onChange={(e) => setQ(e.target.value)} aria-label="Search products"
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const exact = sellable.find((p) => q.trim() && (p.barcode === q.trim() || p.sku?.toLowerCase() === q.trim().toLowerCase()));
                const pick = exact || (visible.length === 1 ? visible[0] : null);
                if (pick) { add(pick); setQ(""); }
              }} />
          </div>
          {biz.mySections.length > 1 && (
            <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
              {[{ id: "all", name: "All" }, ...biz.mySections].map((s) => (
                <button key={s.id} onClick={() => setSection(s.id)}
                  className={cx("whitespace-nowrap rounded-full border px-3 py-1 text-sm font-medium", section === s.id ? "border-brand bg-brand text-white" : "border-slate-300 bg-white text-slate-700")}>
                  {s.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {unpriced > 0 && (
          <Alert tone="info" className="mb-3">
            {unpriced} product{unpriced > 1 ? "s" : ""} {unpriced > 1 ? "are" : "is"} hidden because {unpriced > 1 ? "they have" : "it has"} no selling price yet.
            {biz.canManageAny ? <> <button className="font-semibold underline" onClick={() => router.push("/app/products?filter=needs_price")}>Set prices</button></> : " Ask the owner to set the prices."}
          </Alert>
        )}
        {sellable.length === 0 ? (
          <EmptyState icon={<Package className="size-6" />} title="No products to sell yet"
            action={biz.canManageAny ? <Button onClick={() => router.push("/app/products/import")}>Import products</Button> : undefined}>
            {biz.canManageAny ? "Add or import your products to start selling." : "Ask the owner or manager to add products."}
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState icon={<Search className="size-6" />} title={`Nothing matches "${q}"`}>Try another word, the brand or the model number.</EmptyState>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {visible.map((p) => {
              const inCart = qtyInCart(p.id);
              const left = p.stock_qty - inCart;
              return (
                <button key={p.id} onClick={() => add(p)} disabled={left <= 0}
                  className={cx("group relative flex flex-col overflow-hidden rounded-2xl border bg-white text-left transition active:scale-[0.98] disabled:opacity-50",
                    inCart ? "border-brand ring-2 ring-brand-200" : "border-slate-200 hover:border-brand-300")}>
                  <div className={cx("w-full bg-slate-100", p.image_url ? "aspect-[4/3]" : "aspect-[5/2]")}>
                    <ProductThumb product={p} iconClass="size-8" />
                  </div>
                  <div className="flex flex-1 flex-col p-2.5">
                    <p className="line-clamp-2 text-sm font-semibold leading-tight">{p.name}</p>
                    <p className="mt-0.5 truncate text-xs text-slate-500">{[p.variant_label, p.brand, p.model].filter(Boolean).join(" · ") || " "}</p>
                    <div className="mt-auto flex items-end justify-between pt-1.5">
                      <span className="tabular text-[15px] font-bold text-brand-700">{fmtMoney(p.target_price, cur)}</span>
                      <span className={cx("text-xs font-medium", left <= 0 ? "text-red-600" : left <= p.low_stock_threshold ? "text-amber-700" : "text-slate-500")}>
                        {left <= 0 ? "Out" : `${left} left`}
                      </span>
                    </div>
                  </div>
                  {inCart > 0 && <span className="absolute right-2 top-2 grid size-7 place-items-center rounded-full bg-brand text-sm font-bold text-white">{inCart}</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* desktop cart */}
      <aside className="hidden lg:block">
        <div className="sticky top-20">
          <Card className="flex max-h-[calc(100dvh-7rem)] flex-col">
            <div className="border-b border-slate-100 px-4 py-3 font-semibold">Cart · {items} item{items === 1 ? "" : "s"}</div>
            <div className="flex-1 overflow-y-auto">{cartPanel}</div>
            <div className="space-y-2 border-t border-slate-100 p-4">
              {stockProblems.length > 0 && <Alert tone="danger">Not enough stock for {stockProblems[0].product.name}.</Alert>}
              {err && <Alert tone="danger">{err}</Alert>}
              <Button size="lg" block disabled={!lines.length || needShift && online} onClick={goPay}>Charge {fmtMinor(total, cur)}</Button>
              {lines.length > 0 && <Button variant="ghost" size="sm" block onClick={reset}>Clear cart</Button>}
            </div>
          </Card>
        </div>
      </aside>

      {/* mobile cart bar */}
      {lines.length > 0 && step === "browse" && (
        <div className="fixed inset-x-0 bottom-[64px] z-30 px-3 pb-2 lg:hidden">
          <button onClick={() => setStep("cart")} className="flex w-full items-center gap-3 rounded-2xl bg-ink px-4 py-3.5 text-white shadow-xl">
            <span className="relative"><ShoppingCart className="size-6" /><span className="absolute -right-2 -top-2 grid size-5 place-items-center rounded-full bg-brand text-[11px] font-bold">{items}</span></span>
            <span className="flex-1 text-left font-semibold">View cart</span>
            <span className="tabular text-lg font-bold">{fmtMinor(total, cur)}</span>
          </button>
        </div>
      )}

      <Sheet open={step === "cart"} onClose={() => setStep("browse")} title={`Cart · ${items} item${items === 1 ? "" : "s"}`}
        footer={
          <div className="space-y-2">
            {stockProblems.length > 0 && <Alert tone="danger">Not enough stock for {stockProblems[0].product.name}.</Alert>}
            {err && <Alert tone="danger">{err}</Alert>}
            {needShift && online && <Alert tone="warning">Clock in before recording sales.</Alert>}
            <Button size="lg" block disabled={!lines.length || (needShift && online)} onClick={goPay}>Charge {fmtMinor(total, cur)}</Button>
          </div>
        }>
        {lines.length ? cartPanel : <p className="py-6 text-center text-sm text-slate-500">Cart is empty.</p>}
      </Sheet>

      <Sheet open={!!ovLine} onClose={() => setOvLine(null)} title="Ask owner to approve price"
        footer={<Button block size="lg" onClick={requestOverride} disabled={!online}><ShieldCheck className="size-5" /> Send request</Button>}>
        {ovLine && (
          <div className="space-y-3">
            <div className="rounded-xl bg-slate-50 p-3 text-sm">
              <p className="font-semibold">{ovLine.product.name} × {ovLine.qty}</p>
              <p>Requested price: <b>{fmtMoney(ovLine.price, cur)}</b></p>
              <p className="text-slate-500">Minimum allowed: {fmtMoney(ovLine.product.min_price, cur)}</p>
            </div>
            <Field label="Reason (helps the owner decide)"><Textarea rows={2} value={ovReason} onChange={(e) => setOvReason(e.target.value)} placeholder="e.g. Regular customer buying 3 items" /></Field>
            {!online && <Alert tone="warning">You need a connection to request approval.</Alert>}
            <p className="text-xs text-slate-500">The owner will approve an exact price or decline. This doesn&apos;t change the product&apos;s normal minimum price.</p>
          </div>
        )}
      </Sheet>
    </div>
  );
}

function CartPanel({ lines, total, cur, onQty, onPrice, onRemove, onRequest, onCancelOverride, qtyInCart, online }: {
  lines: Line[]; total: Minor; cur: string; onQty: (k: string, n: number) => void; onPrice: (k: string, v: string) => void;
  onRemove: (k: string) => void; onRequest: (l: Line) => void; onCancelOverride: (l: Line) => void; qtyInCart: (id: string) => number; online: boolean;
}) {
  if (!lines.length) return <p className="px-4 py-10 text-center text-sm text-slate-500">Tap a product to add it.</p>;
  return (
    <ul className="divide-y divide-slate-100">
      {lines.map((l) => {
        const st = lineState(l);
        const lineTotal = Number.isNaN(toMinor(l.price)) ? 0 : toMinor(l.price) * l.qty;
        const over = qtyInCart(l.product.id) > l.product.stock_qty;
        const locked = l.override?.status === "pending" || l.override?.status === "approved";
        return (
          <li key={l.key} className="py-3 lg:px-4">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="font-semibold leading-tight">{l.product.name}{l.product.variant_label ? ` (${l.product.variant_label})` : ""}</p>
                <p className="text-xs text-slate-500">Target {fmtMoney(l.product.target_price, cur)} · Min {fmtMoney(l.product.min_price, cur)} · {l.product.stock_qty} in stock</p>
              </div>
              <button onClick={() => onRemove(l.key)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label={`Remove ${l.product.name}`}><Trash2 className="size-4" /></button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <div className="flex items-center rounded-xl border border-slate-300">
                <button className="grid size-10 place-items-center disabled:opacity-40" onClick={() => onQty(l.key, l.qty - 1)} disabled={l.qty <= 1 || locked} aria-label="Decrease quantity"><Minus className="size-4" /></button>
                <span className="tabular w-8 text-center font-semibold" aria-label="Quantity">{l.qty}</span>
                <button className="grid size-10 place-items-center disabled:opacity-40" onClick={() => onQty(l.key, l.qty + 1)} disabled={locked} aria-label="Increase quantity"><Plus className="size-4" /></button>
              </div>
              <div className="flex-1">
                <MoneyInput aria-label={`Unit price for ${l.product.name}`} value={l.price} onChange={(v) => onPrice(l.key, v)} disabled={locked}
                  className={cx("h-10 text-right font-semibold", !st.ok && "border-red-500")} />
              </div>
            </div>
            <div className="mt-1.5 flex items-center justify-between text-sm">
              <span className="text-slate-500">Line total</span>
              <span className="tabular font-semibold">{fmtMinor(lineTotal, cur)}</span>
            </div>
            {over && <p className="mt-1 text-sm font-medium text-red-600">Only {l.product.stock_qty} in stock</p>}
            {l.override?.status === "pending" && (
              <div className="mt-2 flex items-center gap-2 rounded-xl bg-amber-50 p-2 text-sm text-amber-900">
                <Hourglass className="size-4 animate-pulse" /> <span className="flex-1">Waiting for owner approval…</span>
                <button className="font-semibold underline" onClick={() => onCancelOverride(l)}>Cancel</button>
              </div>
            )}
            {l.override?.status === "approved" && (
              <div className="mt-2 flex items-center gap-2 rounded-xl bg-emerald-50 p-2 text-sm text-emerald-900">
                <ShieldCheck className="size-4" /> <span className="flex-1">Owner approved {fmtMoney(l.override.approved_price, cur)}</span>
                <button className="font-semibold underline" onClick={() => onCancelOverride(l)}>Undo</button>
              </div>
            )}
            {l.override?.status === "rejected" && (
              <div className="mt-2 flex items-center gap-2 rounded-xl bg-red-50 p-2 text-sm text-red-900">
                <CircleX className="size-4" /> Declined{l.override.note ? `: ${l.override.note}` : ""}. Price reset to target.
              </div>
            )}
            {!st.ok && st.belowMin && !l.override && (
              <div className="mt-2 rounded-xl bg-red-50 p-2 text-sm text-red-900">
                <p className="font-medium">{st.reason}. You can&apos;t sell below the minimum without approval.</p>
                <Button size="sm" variant="secondary" className="mt-2" onClick={() => onRequest(l)} disabled={!online}>
                  {online ? <><ShieldCheck className="size-4" /> Ask owner to approve</> : <><WifiOff className="size-4" /> Needs connection</>}
                </Button>
              </div>
            )}
            {!st.ok && !st.belowMin && <p className="mt-1 text-sm text-red-600">{st.reason}</p>}
            {st.ok && !st.belowMin && toMinor(l.price) < toMinor(l.product.target_price) && <Badge tone="info" className="mt-1.5">Negotiated price</Badge>}
          </li>
        );
      })}
      <li className="flex justify-between py-3 text-lg font-bold lg:px-4"><span>Total</span><span className="tabular">{fmtMinor(total, cur)}</span></li>
    </ul>
  );
}
