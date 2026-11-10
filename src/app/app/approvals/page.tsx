"use client";
import { useCallback, useEffect, useState } from "react";
import { useDialog } from "@/components/dialog";
import Link from "next/link";
import { ShieldCheck, Check, X, ClipboardCheck } from "lucide-react";
import { useBiz } from "@/components/biz";
import { useToast } from "@/components/toast";
import { ReviewActions } from "@/components/review-actions";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, MoneyInput, PageHeader, Sheet, Spinner } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { fmtMoney, minorToDecimal, toMinor } from "@/lib/money";
import { errorMessage, fmtDateTime, receiptLabel } from "@/lib/format";
import type { Sale } from "@/lib/types";

interface Ov {
  id: string; section_id: string; requested_price: number; quantity: number; reason: string | null; created_at: string;
  products?: { name: string; variant_label: string | null; target_price: number; min_price: number } | null;
  requester?: { full_name: string | null } | null;
}
interface Exp { id: string; section_id: string | null; category: string; amount: number; description: string | null; expense_date: string; submitted_by: string; submitter?: { full_name: string | null } | null }

export default function ApprovalsPage() {
  const biz = useBiz();
  const { business, userId } = biz;
  const toast = useToast();
  const dialog = useDialog();
  const cur = business.currency;
  const [ovs, setOvs] = useState<Ov[] | null>(null);
  const [exps, setExps] = useState<Exp[]>([]);
  const [reviews, setReviews] = useState<Sale[]>([]);
  const [costs, setCosts] = useState<Record<string, number>>({});
  const [deciding, setDeciding] = useState<Ov | null>(null);

  const load = useCallback(async () => {
    const sb = supabase();
    const [o, e, r] = await Promise.all([
      sb.from("price_override_requests").select("*, products(name, variant_label, target_price, min_price), requester:profiles!price_override_requests_requested_by_fkey(full_name)")
        .eq("business_id", business.id).eq("status", "pending").order("created_at"),
      sb.from("expenses").select("*, submitter:profiles!expenses_submitted_by_fkey(full_name)").eq("business_id", business.id).eq("status", "pending").order("created_at"),
      sb.from("sales").select("*, profiles!sales_staff_user_id_fkey(full_name, email)").eq("business_id", business.id).eq("status", "pending_review").order("sold_at"),
    ]);
    const list = (o.data || []) as (Ov & { product_id: string })[];
    setOvs(list); setExps((e.data || []) as Exp[]); setReviews((r.data || []) as Sale[]);
    if (list.length && biz.costsAnywhere) {
      const { data } = await sb.from("product_costs").select("product_id, avg_cost").in("product_id", list.map((x) => x.product_id));
      const m: Record<string, number> = {}; for (const c of (data || []) as { product_id: string; avg_cost: number }[]) m[c.product_id] = c.avg_cost; setCosts(m);
    }
  }, [business.id, biz.costsAnywhere]);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);

  async function decideExpense(e: Exp, approve: boolean) {
    let note: string | null = null;
    if (!approve) { note = await dialog.prompt({ title: "Reject this expense?", label: "Reason (optional)", placeholder: "e.g. no receipt", confirmLabel: "Reject", tone: "danger" }); if (note === null) return; }
    const { error } = await supabase().rpc("decide_expense", { p_expense: e.id, p_approve: approve, p_note: note });
    if (error) toast(errorMessage(error), "error"); else { toast(approve ? "Expense approved" : "Expense rejected"); load(); }
  }

  if (ovs === null) return <Spinner />;
  const nothing = !ovs.length && !exps.length && !reviews.length;

  return (
    <div className="space-y-5">
      <PageHeader title="Approvals" subtitle="Price overrides, expense claims and offline sales that need a decision" />
      {nothing && <EmptyState icon={<ClipboardCheck className="size-6" />} title="All caught up">Nothing is waiting for you. New requests appear here automatically.</EmptyState>}

      {ovs.length > 0 && (
        <section>
          <h2 className="mb-2 font-semibold">Price overrides ({ovs.length})</h2>
          <div className="space-y-2">
            {ovs.map((o) => {
              const pid = (o as Ov & { product_id: string }).product_id;
              const cost = costs[pid];
              return (
                <Card key={o.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold">{o.products?.name}{o.products?.variant_label ? ` (${o.products.variant_label})` : ""} × {o.quantity}</p>
                      <p className="text-sm text-slate-600">{o.requester?.full_name} asks for <b className="tabular">{fmtMoney(o.requested_price, cur)}</b> each</p>
                      <p className="text-xs text-slate-500">Target {fmtMoney(o.products?.target_price, cur)} · Min {fmtMoney(o.products?.min_price, cur)}{biz.canViewCosts(o.section_id) && cost !== undefined ? ` · Cost ${fmtMoney(cost, cur)}` : ""} · {fmtDateTime(o.created_at, business.timezone)}</p>
                      {o.reason && <p className="mt-1 text-sm italic text-slate-600">&ldquo;{o.reason}&rdquo;</p>}
                      {biz.canViewCosts(o.section_id) && cost !== undefined && toMinor(o.requested_price) < toMinor(cost) && <Badge tone="danger" className="mt-1">Below cost: you would lose money</Badge>}
                    </div>
                  </div>
                  {biz.canApprove(o.section_id) ? (
                    <div className="mt-3 flex gap-2">
                      <Button size="sm" variant="success" onClick={() => setDeciding(o)}><ShieldCheck className="size-4" /> Approve…</Button>
                      <Button size="sm" variant="secondary" onClick={async () => {
                        const note = await dialog.prompt({ title: "Decline this price?", message: "The shopkeeper will have to sell at the normal price.", label: "Reason (shown to staff, optional)", confirmLabel: "Decline", tone: "danger" });
                        if (note === null) return;
                        const { error } = await supabase().rpc("decide_price_override", { p_request: o.id, p_approve: false, p_approved_price: null, p_note: note });
                        if (error) toast(errorMessage(error), "error"); else { toast("Declined"); load(); }
                      }}><X className="size-4" /> Decline</Button>
                    </div>
                  ) : <p className="mt-2 text-xs text-slate-500">Only the owner or this section&apos;s owner can decide.</p>}
                </Card>
              );
            })}
          </div>
        </section>
      )}

      {exps.length > 0 && (
        <section>
          <h2 className="mb-2 font-semibold">Expense claims ({exps.length})</h2>
          <Card>
            <ul className="divide-y divide-slate-100">
              {exps.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{e.category} · <span className="tabular">{fmtMoney(e.amount, cur)}</span></p>
                    <p className="text-xs text-slate-500">{e.submitter?.full_name} · {e.section_id ? biz.sections.find((s) => s.id === e.section_id)?.name : "Whole business"}{e.description ? ` · ${e.description}` : ""}</p>
                  </div>
                  {e.submitted_by !== userId && (
                    <div className="flex gap-2">
                      <Button size="sm" variant="success" onClick={() => decideExpense(e, true)}><Check className="size-4" /> Approve</Button>
                      <Button size="sm" variant="secondary" onClick={() => decideExpense(e, false)}><X className="size-4" /> Reject</Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {reviews.length > 0 && (
        <section>
          <h2 className="mb-2 font-semibold">Offline sales to review ({reviews.length})</h2>
          <div className="space-y-2">
            {reviews.map((s) => (
              <Card key={s.id} className="p-4">
                <div className="flex justify-between gap-2">
                  <div>
                    <Link href={`/app/sales/view?id=${s.id}`} className="font-semibold text-brand underline">{receiptLabel(s.receipt_no)}</Link>
                    <span className="text-sm"> · {s.profiles?.full_name || s.profiles?.email} · {fmtDateTime(s.sold_at, business.timezone)}</span>
                    <ul className="mt-1 list-disc pl-5 text-sm text-amber-900">{s.conflicts.map((c, i) => <li key={i}>{c}</li>)}</ul>
                  </div>
                  <p className="tabular font-semibold">{fmtMoney(s.total, cur)}</p>
                </div>
                <div className="mt-3"><ReviewActions sale={s} onDone={load} /></div>
              </Card>
            ))}
          </div>
        </section>
      )}

      {deciding && <ApproveSheet ov={deciding} cur={cur} onClose={() => setDeciding(null)} onDone={() => { setDeciding(null); load(); toast("Approved. The staff member can now complete the sale."); }} />}
    </div>
  );
}

function ApproveSheet({ ov, cur, onClose, onDone }: { ov: Ov; cur: string; onClose: () => void; onDone: () => void }) {
  const [price, setPrice] = useState(String(ov.requested_price));
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!(toMinor(price) > 0)) { setErr("Enter the exact price you approve."); return; }
    setBusy(true); setErr(null);
    const { error } = await supabase().rpc("decide_price_override", { p_request: ov.id, p_approve: true, p_approved_price: minorToDecimal(toMinor(price)), p_note: note || null });
    setBusy(false);
    if (error) setErr(errorMessage(error)); else onDone();
  }
  return (
    <Sheet open onClose={onClose} title="Approve exact price" footer={<Button block size="lg" variant="success" loading={busy} onClick={save}>Approve {fmtMoney(minorToDecimal(toMinor(price) || 0), cur)}</Button>}>
      <div className="space-y-3">
        <p className="text-sm">{ov.products?.name} × {ov.quantity}. Requested {fmtMoney(ov.requested_price, cur)}.</p>
        <Field label="Approved price per unit" hint="You can meet the customer halfway"><MoneyInput value={price} onChange={setPrice} /></Field>
        <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <Alert tone="info">This applies to this sale only. The product&apos;s normal minimum price is not changed.</Alert>
        {err && <Alert tone="danger">{err}</Alert>}
      </div>
    </Sheet>
  );
}
