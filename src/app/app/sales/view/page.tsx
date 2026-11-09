"use client";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toPng } from "html-to-image";
import { ChevronLeft, Share2, Printer, Download, MessageCircle, CloudUpload, ShoppingCart, Plus, Ban } from "lucide-react";
import { useBiz } from "@/components/biz";
import { useToast } from "@/components/toast";
import { PaymentBadge } from "@/components/badges";
import { ReviewActions } from "@/components/review-actions";
import { Alert, Button, Card, Field, Input, MoneyInput, Select, Sheet, Spinner, Textarea } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { db, syncedSaleId, type QueuedSale } from "@/lib/offline";
import { useBrand } from "@/lib/brand";
import { fmtMoney, minorToDecimal, toMinor } from "@/lib/money";
import { errorMessage, fmtDateTime, receiptLabel } from "@/lib/format";
import type { Payment, PaymentMethod, Sale, SaleLine } from "@/lib/types";

function ViewInner() {
  const params = useSearchParams();
  const id = params.get("id");
  const offlineId = params.get("offline");
  const isNew = params.get("new");
  const router = useRouter();
  const biz = useBiz();
  const { business } = biz;
  const { brand } = useBrand();
  const toast = useToast();
  const cur = business.currency;
  const ref = useRef<HTMLDivElement>(null);

  const [sale, setSale] = useState<Sale | null>(null);
  const [lines, setLines] = useState<SaleLine[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [queued, setQueued] = useState<QueuedSale | null>(null);
  const [missing, setMissing] = useState(false);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [payOpen, setPayOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);

  const load = useCallback(async () => {
    if (offlineId) {
      const q = await db().queue.get(offlineId);
      if (q) { setQueued(q); return; }
      const synced = await syncedSaleId(offlineId);
      if (synced) { router.replace(`/app/sales/view?id=${synced}`); return; }
      setMissing(true); return;
    }
    if (!id) { setMissing(true); return; }
    const sb = supabase();
    const [s, l, p] = await Promise.all([
      sb.from("sales").select("*, profiles!sales_staff_user_id_fkey(full_name, email)").eq("id", id).maybeSingle(),
      sb.from("sale_lines").select("*").eq("sale_id", id),
      sb.from("payments").select("*").eq("sale_id", id).order("created_at"),
    ]);
    if (!s.data) { setMissing(true); return; }
    setSale(s.data as Sale); setLines((l.data || []) as SaleLine[]); setPayments((p.data || []) as Payment[]);
  }, [id, offlineId, router]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    supabase().from("payment_methods").select("*").eq("business_id", business.id).eq("active", true).order("sort").then(({ data }) => setMethods((data || []) as PaymentMethod[]));
  }, [business.id]);

  if (missing) return <Alert tone="warning" title="Receipt not found">It may belong to another business or you may not have access.</Alert>;
  if (!sale && !queued) return <Spinner />;

  const lineSections = Array.from(new Set(lines.map((l) => l.section_id)));
  const canApproveAll = lineSections.length > 0 && lineSections.every((s) => biz.canApprove(s));
  const canCollect = sale && sale.status === "completed" && sale.balance_due > 0 && biz.role !== "accountant";

  function receiptText(): string {
    if (!sale) return "";
    const rows = lines.map((l) => `${l.quantity} x ${l.product_name} @ ${fmtMoney(l.unit_price, cur)} = ${fmtMoney(l.line_total, cur)}`);
    const pays = payments.map((p) => `${p.method_name}: ${fmtMoney(p.amount, cur)}`);
    return [
      `${business.name} — Receipt ${receiptLabel(sale.receipt_no)}`,
      fmtDateTime(sale.sold_at, business.timezone), "", ...rows, "",
      `TOTAL: ${fmtMoney(sale.total, cur)}`, ...pays,
      sale.balance_due > 0 ? `BALANCE DUE: ${fmtMoney(sale.balance_due, cur)}` : "PAID IN FULL",
      "", business.receipt_footer || "", business.phone || "",
    ].filter((x) => x !== undefined).join("\n");
  }

  async function imageBlob(): Promise<Blob | null> {
    if (!ref.current) return null;
    const url = await toPng(ref.current, { pixelRatio: 2, backgroundColor: "#ffffff" });
    return (await fetch(url)).blob();
  }

  async function share() {
    try {
      const blob = await imageBlob();
      const file = blob ? new File([blob], `receipt-${sale?.receipt_no}.png`, { type: "image/png" }) : null;
      if (file && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: `Receipt ${receiptLabel(sale?.receipt_no)}`, text: receiptText() });
      } else if (navigator.share) {
        await navigator.share({ title: `Receipt ${receiptLabel(sale?.receipt_no)}`, text: receiptText() });
      } else {
        await download();
      }
    } catch (e) { if ((e as Error).name !== "AbortError") toast("Could not share. Try Download instead.", "error"); }
  }
  async function download() {
    const blob = await imageBlob();
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `receipt-${sale?.receipt_no}.png`;
    a.click();
  }
  function whatsapp() {
    const phone = (sale?.customer_phone || "").replace(/\D/g, "");
    const to = phone ? (phone.length === 9 ? `237${phone}` : phone) : "";
    window.open(`https://wa.me/${to}?text=${encodeURIComponent(receiptText())}`, "_blank");
  }

  // ------------------------------------------------------------ offline receipt
  if (queued) {
    return (
      <div className="mx-auto max-w-md space-y-4">
        <Alert tone="warning" title="Saved offline — pending sync">
          This sale is stored on this phone. It gets a receipt number once it syncs. If stock or prices changed meanwhile, the owner will review it.
        </Alert>
        <Card className="p-5">
          <p className="text-center text-lg font-bold">{business.name}</p>
          <p className="text-center text-xs text-slate-500">Provisional receipt · ref {queued.client_tx_id.slice(0, 8).toUpperCase()}</p>
          <ul className="my-4 space-y-1 text-sm">
            {queued.display.lines.map((l, i) => (
              <li key={i} className="flex justify-between gap-2"><span>{l.quantity} × {l.name}</span><span className="tabular">{fmtMoney(minorToDecimal(toMinor(l.unit_price) * l.quantity), cur)}</span></li>
            ))}
          </ul>
          <div className="space-y-1 border-t border-dashed border-slate-300 pt-3 text-sm">
            <div className="flex justify-between font-bold"><span>Total</span><span className="tabular">{fmtMoney(queued.display.total, cur)}</span></div>
            <div className="flex justify-between"><span>Paid</span><span className="tabular">{fmtMoney(queued.display.paid, cur)}</span></div>
          </div>
        </Card>
        <div className="grid grid-cols-2 gap-2">
          <Link href="/app/sales?tab=queue"><Button variant="secondary" block><CloudUpload className="size-4" /> Sync queue</Button></Link>
          <Link href="/app/pos"><Button block><ShoppingCart className="size-4" /> New sale</Button></Link>
        </div>
      </div>
    );
  }

  const s = sale!;
  return (
    <div className="mx-auto max-w-md space-y-4">
      <div className="no-print flex items-center justify-between">
        <button onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm font-medium text-slate-600"><ChevronLeft className="size-4" /> Back</button>
        <PaymentBadge sale={s} />
      </div>
      {isNew && <Alert tone="success" className="no-print" title="Sale completed">Stock has been updated. Share the receipt with the customer.</Alert>}
      {s.status === "pending_review" && (
        <Alert tone="warning" title="Offline sale needs owner review" className="no-print">
          <ul className="list-disc pl-4">{s.conflicts.map((c, i) => <li key={i}>{c}</li>)}</ul>
          <p className="mt-1">Stock has not been changed yet.</p>
        </Alert>
      )}
      {(s.status === "voided" || s.status === "rejected") && (
        <Alert tone="danger" title={s.status === "voided" ? "This sale was voided" : "This offline sale was rejected"} className="no-print">
          {s.decision_reason}. Stock was {s.status === "voided" ? "returned" : "never taken"}; it does not count as revenue.
        </Alert>
      )}

      <div ref={ref} className="print-area rounded-2xl border border-slate-200 bg-white p-5">
        <div className="text-center">
          {business.logo_url && /* eslint-disable-next-line @next/next/no-img-element */ <img src={business.logo_url} alt="" className="mx-auto mb-2 h-12" crossOrigin="anonymous" />}
          <p className="text-lg font-bold">{business.name}</p>
          {business.address && <p className="text-xs text-slate-500">{business.address}</p>}
          {business.phone && <p className="text-xs text-slate-500">{business.phone}</p>}
        </div>
        <div className="my-4 grid grid-cols-2 gap-y-1 border-y border-dashed border-slate-300 py-3 text-xs">
          <span className="text-slate-500">Receipt</span><span className="text-right font-semibold">{receiptLabel(s.receipt_no)}</span>
          <span className="text-slate-500">Date</span><span className="text-right">{fmtDateTime(s.sold_at, business.timezone)}</span>
          <span className="text-slate-500">Served by</span><span className="text-right">{s.profiles?.full_name || s.profiles?.email || "—"}</span>
          {s.customer_name && <><span className="text-slate-500">Customer</span><span className="text-right">{s.customer_name}{s.customer_phone ? ` · ${s.customer_phone}` : ""}</span></>}
        </div>
        <ul className="space-y-2 text-sm">
          {lines.map((l) => (
            <li key={l.id}>
              <div className="flex justify-between gap-2"><span className="font-medium">{l.product_name}</span><span className="tabular whitespace-nowrap font-semibold">{fmtMoney(l.line_total, cur)}</span></div>
              <p className="tabular text-xs text-slate-500">{l.quantity} × {fmtMoney(l.unit_price, cur)}</p>
            </li>
          ))}
        </ul>
        <div className="mt-4 space-y-1 border-t border-dashed border-slate-300 pt-3 text-sm">
          <div className="flex justify-between text-base font-bold"><span>Total</span><span className="tabular">{fmtMoney(s.total, cur)}</span></div>
          {payments.map((p) => (
            <div key={p.id} className="flex justify-between text-slate-600">
              <span>{p.method_name}{p.reference ? ` (${p.reference})` : ""}</span><span className="tabular whitespace-nowrap">{fmtMoney(p.amount, cur)}</span>
            </div>
          ))}
          <div className={`flex justify-between border-t border-slate-200 pt-1 font-bold ${s.balance_due > 0 ? "text-amber-700" : "text-emerald-700"}`}>
            <span>{s.balance_due > 0 ? "Balance due" : "Paid in full"}</span><span className="tabular">{fmtMoney(s.balance_due > 0 ? s.balance_due : s.amount_paid, cur)}</span>
          </div>
        </div>
        {business.receipt_footer && <p className="mt-4 text-center text-xs text-slate-500">{business.receipt_footer}</p>}
        <p className="mt-2 text-center text-[10px] text-slate-400">Powered by {brand.product_name}</p>
      </div>

      {(s.status === "completed" || s.status === "pending_review") && (
        <div className="no-print grid grid-cols-2 gap-2">
          <Button onClick={share}><Share2 className="size-4" /> Share</Button>
          <Button variant="secondary" onClick={whatsapp}><MessageCircle className="size-4" /> WhatsApp</Button>
          <Button variant="secondary" onClick={download}><Download className="size-4" /> Download</Button>
          <Button variant="secondary" onClick={() => window.print()}><Printer className="size-4" /> Print / PDF</Button>
        </div>
      )}

      <div className="no-print space-y-2">
        {canCollect && <Button block variant="success" size="lg" onClick={() => setPayOpen(true)}><Plus className="size-5" /> Record payment of balance</Button>}
        {s.status === "pending_review" && canApproveAll && <ReviewActions sale={s} onDone={load} />}
        {s.status === "completed" && canApproveAll && <Button block variant="ghost" className="text-red-700" onClick={() => setVoidOpen(true)}><Ban className="size-4" /> Void this sale</Button>}
        {isNew && <Link href="/app/pos"><Button block size="lg" variant="secondary"><ShoppingCart className="size-5" /> Next sale</Button></Link>}
      </div>

      {payOpen && <PaymentSheet sale={s} methods={methods} cur={cur} onClose={() => setPayOpen(false)} onDone={() => { setPayOpen(false); load(); toast("Payment recorded"); }} />}
      {voidOpen && <VoidSheet sale={s} onClose={() => setVoidOpen(false)} onDone={() => { setVoidOpen(false); load(); toast("Sale voided and stock returned"); }} />}
    </div>
  );
}

function PaymentSheet({ sale, methods, cur, onClose, onDone }: { sale: Sale; methods: PaymentMethod[]; cur: string; onClose: () => void; onDone: () => void }) {
  const [method, setMethod] = useState(methods[0]?.id || "");
  const [amount, setAmount] = useState(String(sale.balance_due));
  const [refNo, setRefNo] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setErr(null);
    const { error } = await supabase().rpc("add_payment", { p_sale: sale.id, p_method: method, p_amount: minorToDecimal(toMinor(amount)), p_reference: refNo || null });
    setBusy(false);
    if (error) setErr(errorMessage(error)); else onDone();
  }
  return (
    <Sheet open onClose={onClose} title="Record payment" footer={<Button block size="lg" loading={busy} onClick={save}>Save payment</Button>}>
      <div className="space-y-3">
        <p className="text-sm">Balance due: <b className="tabular">{fmtMoney(sale.balance_due, cur)}</b></p>
        <Field label="Method"><Select value={method} onChange={(e) => setMethod(e.target.value)}>{methods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
        <Field label="Amount"><MoneyInput value={amount} onChange={setAmount} /></Field>
        <Field label="Transaction ID (optional)"><Input value={refNo} onChange={(e) => setRefNo(e.target.value)} /></Field>
        {err && <Alert tone="danger">{err}</Alert>}
      </div>
    </Sheet>
  );
}

function VoidSheet({ sale, onClose, onDone }: { sale: Sale; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setErr(null);
    const { error } = await supabase().rpc("void_sale", { p_sale: sale.id, p_reason: reason });
    setBusy(false);
    if (error) setErr(errorMessage(error)); else onDone();
  }
  return (
    <Sheet open onClose={onClose} title={`Void receipt ${receiptLabel(sale.receipt_no)}?`} footer={<Button block size="lg" variant="danger" loading={busy} disabled={!reason.trim()} onClick={save}>Void sale</Button>}>
      <div className="space-y-3">
        <Alert tone="warning">Voiding returns all items to stock and removes the sale from revenue. Any money collected should be refunded to the customer. This is recorded in the audit log.</Alert>
        <Field label="Reason"><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer returned the item the same day" /></Field>
        {err && <Alert tone="danger">{err}</Alert>}
      </div>
    </Sheet>
  );
}

export default function ViewSale() {
  return <Suspense><ViewInner /></Suspense>;
}

