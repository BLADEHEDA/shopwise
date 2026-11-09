"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Plus, Trash2 } from "lucide-react";
import { useBiz } from "@/components/biz";
import { useToast } from "@/components/toast";
import { Alert, Button, Card, Field, Input, MoneyInput, PageHeader, Select, Spinner } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { fmtMinor, minorToDecimal, toMinor } from "@/lib/money";
import { errorMessage, todayIn, uuid } from "@/lib/format";
import type { Product } from "@/lib/types";

interface Line { key: string; product_id: string; qty: string; price: string }

export default function ReceivePage() {
  const biz = useBiz();
  const { business } = biz;
  const router = useRouter();
  const toast = useToast();
  const cur = business.currency;
  const allowed = biz.sections.filter((s) => s.active && biz.canManage(s.id) && biz.canViewCosts(s.id));

  const [section, setSection] = useState(allowed[0]?.id || "");
  const [products, setProducts] = useState<Product[] | null>(null);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [supplier, setSupplier] = useState("");
  const [source, setSource] = useState<"local" | "import">("local");
  const [currency, setCurrency] = useState(business.currency);
  const [rate, setRate] = useState("1");
  const [date, setDate] = useState(todayIn(business.timezone));
  const [freight, setFreight] = useState("");
  const [other, setOther] = useState("");
  const [method, setMethod] = useState<"value" | "quantity">("value");
  const [reference, setReference] = useState("");
  const [lines, setLines] = useState<Line[]>([{ key: uuid(), product_id: "", qty: "", price: "" }]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const sb = supabase();
    sb.from("products").select("*").eq("business_id", business.id).eq("active", true).order("name").then(({ data }) => setProducts((data || []) as Product[]));
    sb.from("suppliers").select("id, name").eq("business_id", business.id).order("name").then(({ data }) => setSuppliers(data || []));
  }, [business.id]);

  const inSection = (products || []).filter((p) => p.section_id === section);
  const sameCur = currency === business.currency;
  const rateM = sameCur ? 100 : toMinor(rate); // rate as minor (x100) to keep integer math

  // Live landed-cost preview — mirrors the database calculation.
  const preview = useMemo(() => {
    const rows = lines.map((l) => {
      const q = parseInt(l.qty || "0", 10) || 0;
      const unitLocal = Math.round((toMinor(l.price) * rateM) / 100); // minor units in local currency
      return { key: l.key, q, unitLocal, value: q * unitLocal };
    });
    const extra = (toMinor(freight) || 0) + (toMinor(other) || 0);
    const totalValue = rows.reduce((a, r) => a + r.value, 0);
    const totalQty = rows.reduce((a, r) => a + r.q, 0);
    let used = 0;
    const out = rows.map((r, i) => {
      let alloc = 0;
      if (i === rows.length - 1) alloc = extra - used;
      else if (method === "quantity" || totalValue === 0) alloc = totalQty ? Math.round((extra * r.q) / totalQty) : 0;
      else alloc = Math.round((extra * r.value) / totalValue);
      used += alloc;
      return { ...r, alloc, landed: r.q ? Math.round((r.value + alloc) / r.q) : 0 };
    });
    return { rows: out, total: totalValue + extra, extra };
  }, [lines, freight, other, method, rateM]);

  if (!allowed.length) return <Alert tone="warning">Only owners, or managers with financial access, can receive purchases.</Alert>;
  if (products === null) return <Spinner />;

  async function save() {
    setErr(null);
    const valid = lines.filter((l) => l.product_id && parseInt(l.qty || "0", 10) > 0);
    if (!valid.length) return setErr("Add at least one product with a quantity.");
    if (valid.some((l) => Number.isNaN(toMinor(l.price)) || l.price === "")) return setErr("Enter the unit price for every line (0 if free).");
    if (!sameCur && !(toMinor(rate) > 0)) return setErr("Enter the exchange rate.");
    setBusy(true);
    const ex = suppliers.find((s) => s.name.toLowerCase() === supplier.trim().toLowerCase());
    const { error } = await supabase().rpc("receive_purchase", { p: {
      business_id: business.id, section_id: section, supplier_id: ex?.id || null, supplier_name: ex ? null : supplier.trim() || null,
      supplier_country: source === "import" ? "China" : null, source, currency, exchange_rate: sameCur ? "1" : rate, purchase_date: date,
      freight_cost: freight ? minorToDecimal(toMinor(freight)) : "0", other_costs: other ? minorToDecimal(toMinor(other)) : "0",
      allocation_method: method, reference: reference || null,
      lines: valid.map((l) => ({ product_id: l.product_id, quantity: parseInt(l.qty, 10), unit_price: minorToDecimal(toMinor(l.price)) })),
    } });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    toast("Stock received and costs updated");
    router.push("/app/inventory");
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <button onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm font-medium text-slate-600"><ChevronLeft className="size-4" /> Inventory</button>
      <PageHeader title="Receive stock" subtitle="Records a purchase batch, adds stock and updates the weighted average cost." />

      <Card className="grid gap-3 p-4 sm:grid-cols-2">
        <Field label="Section"><Select value={section} onChange={(e) => { setSection(e.target.value); setLines([{ key: uuid(), product_id: "", qty: "", price: "" }]); }}>{allowed.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        <Field label="Supplier">
          <Input list="suppliers" value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Type or choose" />
          <datalist id="suppliers">{suppliers.map((s) => <option key={s.id} value={s.name} />)}</datalist>
        </Field>
        <Field label="Source"><Select value={source} onChange={(e) => { const v = e.target.value as "local" | "import"; setSource(v); if (v === "local") setCurrency(business.currency); }}>
          <option value="local">Local supplier</option><option value="import">Imported (e.g. China)</option></Select></Field>
        <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        {source === "import" && (
          <>
            <Field label="Supplier price currency"><Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {[business.currency, "CNY", "USD", "EUR", "NGN"].filter((v, i, a) => a.indexOf(v) === i).map((c) => <option key={c} value={c}>{c}</option>)}</Select></Field>
            {!sameCur && <Field label={`1 ${currency} = ? ${business.currency === "XAF" ? "FCFA" : business.currency}`}><MoneyInput value={rate} onChange={setRate} /></Field>}
          </>
        )}
        <Field label="Reference / invoice no. (optional)"><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 font-semibold">Items</h2>
        <div className="space-y-3">
          {lines.map((l, i) => {
            const pv = preview.rows[i];
            return (
              <div key={l.key} className="rounded-xl border border-slate-200 p-3">
                <div className="flex gap-2">
                  <Select value={l.product_id} onChange={(e) => setLines(lines.map((x) => (x.key === l.key ? { ...x, product_id: e.target.value } : x)))} aria-label="Product">
                    <option value="">Choose product…</option>
                    {inSection.map((p) => <option key={p.id} value={p.id}>{p.name}{p.variant_label ? ` (${p.variant_label})` : ""}</option>)}
                  </Select>
                  {lines.length > 1 && <Button variant="ghost" onClick={() => setLines(lines.filter((x) => x.key !== l.key))} aria-label="Remove line"><Trash2 className="size-4" /></Button>}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Input inputMode="numeric" placeholder="Quantity" value={l.qty} onChange={(e) => setLines(lines.map((x) => (x.key === l.key ? { ...x, qty: e.target.value.replace(/\D/g, "") } : x)))} />
                  <MoneyInput placeholder={`Unit price (${currency})`} value={l.price} onChange={(v) => setLines(lines.map((x) => (x.key === l.key ? { ...x, price: v } : x)))} />
                </div>
                {pv && pv.q > 0 && (
                  <p className="mt-2 text-xs text-slate-600">
                    {!sameCur && <>Unit {fmtMinor(pv.unitLocal, cur)} · </>}+ {fmtMinor(pv.alloc, cur)} freight/other · <b>Landed {fmtMinor(pv.landed, cur)} / unit</b>
                  </p>
                )}
              </div>
            );
          })}
          <Button variant="secondary" size="sm" onClick={() => setLines([...lines, { key: uuid(), product_id: "", qty: "", price: "" }])}><Plus className="size-4" /> Add item</Button>
        </div>
      </Card>

      <Card className="grid gap-3 p-4 sm:grid-cols-3">
        <Field label={`Freight / shipping (${cur === "XAF" ? "FCFA" : cur})`}><MoneyInput value={freight} onChange={setFreight} placeholder="0" /></Field>
        <Field label="Customs / other costs"><MoneyInput value={other} onChange={setOther} placeholder="0" /></Field>
        <Field label="Share extra costs by" hint="Shown on the batch record"><Select value={method} onChange={(e) => setMethod(e.target.value as "value" | "quantity")}>
          <option value="value">Item value</option><option value="quantity">Quantity</option></Select></Field>
        <div className="rounded-xl bg-slate-50 p-3 text-sm sm:col-span-3">
          Total landed cost of this batch: <b className="tabular">{fmtMinor(preview.total, cur)}</b>{preview.extra ? <> (includes {fmtMinor(preview.extra, cur)} extra costs)</> : null}
        </div>
      </Card>

      {err && <Alert tone="danger">{err}</Alert>}
      <Button size="lg" block loading={busy} onClick={save}>Receive stock</Button>
    </div>
  );
}
