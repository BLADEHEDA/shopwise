"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useDialog } from "@/components/dialog";
import { useSearchParams } from "next/navigation";
import { Plus, Wallet, Check, X } from "lucide-react";
import { useBiz } from "@/components/biz";
import { useToast } from "@/components/toast";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, MoneyInput, PageHeader, Select, Sheet, Spinner, Tabs, Textarea } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { fmtMoney, minorToDecimal, toMinor } from "@/lib/money";
import { errorMessage, fmtDate, todayIn } from "@/lib/format";

interface Expense {
  id: string; business_id: string; section_id: string | null; category: string; amount: number; expense_date: string; description: string | null;
  payment_method: string | null; status: "pending" | "approved" | "rejected"; submitted_by: string; decided_at: string | null; decision_note: string | null;
  submitter?: { full_name: string | null } | null; decider?: { full_name: string | null } | null;
}
const CATEGORIES = ["Transport", "Rent", "Electricity", "Internet / airtime", "Salaries", "Repairs", "Packaging", "Cleaning", "Taxes & fees", "Other"];

function ExpensesInner() {
  const biz = useBiz();
  const { business, sections, userId } = biz;
  const toast = useToast();
  const dialog = useDialog();
  const [tab, setTab] = useState<"pending" | "approved" | "rejected" | "all">("all");
  const [rows, setRows] = useState<Expense[] | null>(null);
  const [open, setOpen] = useState(useSearchParams().get("new") === "1");
  const cur = business.currency;

  const load = useCallback(() => {
    let q = supabase().from("expenses").select("*, submitter:profiles!expenses_submitted_by_fkey(full_name), decider:profiles!expenses_decided_by_fkey(full_name)")
      .eq("business_id", business.id).order("expense_date", { ascending: false }).order("created_at", { ascending: false }).limit(200);
    if (tab !== "all") q = q.eq("status", tab);
    q.then(({ data }) => setRows((data || []) as Expense[]));
  }, [business.id, tab]);
  useEffect(load, [load]);

  const canDecide = (e: Expense) => biz.isOwner || (e.section_id ? (biz.canApprove(e.section_id) || (biz.role === "manager" && biz.canViewCosts(e.section_id))) : false);
  const total = (rows || []).filter((e) => e.status === "approved").reduce((a, e) => a + Number(e.amount), 0);

  async function decide(e: Expense, approve: boolean) {
    let note: string | null = null;
    if (!approve) { note = await dialog.prompt({ title: "Reject this expense?", label: "Reason (optional)", placeholder: "e.g. no receipt", confirmLabel: "Reject", tone: "danger" }); if (note === null) return; }
    const { error } = await supabase().rpc("decide_expense", { p_expense: e.id, p_approve: approve, p_note: note });
    if (error) toast(errorMessage(error), "error"); else { toast(approve ? "Expense approved" : "Expense rejected"); load(); }
  }

  return (
    <div>
      <PageHeader title="Expenses" subtitle="Only approved expenses reduce net profit." actions={biz.role !== "accountant" && <Button onClick={() => setOpen(true)}><Plus className="size-4" /> {biz.canApproveAny ? "Record expense" : "Submit expense"}</Button>} />
      <Tabs value={tab} onChange={setTab} items={[{ value: "all", label: "All" }, { value: "pending", label: "Pending" }, { value: "approved", label: "Approved" }, { value: "rejected", label: "Rejected" }]} />
      {rows === null ? <Spinner /> : rows.length === 0 ? (
        <EmptyState icon={<Wallet className="size-6" />} title="No expenses" action={biz.role !== "accountant" ? <Button onClick={() => setOpen(true)}>Add the first one</Button> : undefined}>
          Record shop costs like transport, rent and electricity so your net profit is accurate.
        </EmptyState>
      ) : (
        <Card>
          {tab !== "pending" && tab !== "rejected" && <div className="border-b border-slate-100 px-4 py-2.5 text-right text-sm text-slate-600">Approved total <b className="tabular text-ink">{fmtMoney(total, cur)}</b></div>}
          <ul className="divide-y divide-slate-100">
            {rows.map((e) => (
              <li key={e.id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{e.category} <span className="text-sm font-normal text-slate-500">· {e.section_id ? sections.find((s) => s.id === e.section_id)?.name : "Whole business"}</span></p>
                    <p className="text-xs text-slate-500">{fmtDate(e.expense_date)} · by {e.submitter?.full_name || "—"}{e.payment_method ? ` · ${e.payment_method}` : ""}</p>
                    {e.description && <p className="mt-0.5 text-sm text-slate-600">{e.description}</p>}
                    {e.status !== "pending" && e.decider && <p className="mt-0.5 text-xs text-slate-500">{e.status === "approved" ? "Approved" : "Rejected"} by {e.decider.full_name}{e.decision_note ? `: ${e.decision_note}` : ""}</p>}
                  </div>
                  <div className="text-right">
                    <p className="tabular font-semibold">{fmtMoney(e.amount, cur)}</p>
                    <Badge tone={e.status === "approved" ? "success" : e.status === "pending" ? "warning" : "neutral"}>{e.status}</Badge>
                  </div>
                </div>
                {e.status === "pending" && canDecide(e) && e.submitted_by !== userId && (
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="success" onClick={() => decide(e, true)}><Check className="size-4" /> Approve</Button>
                    <Button size="sm" variant="secondary" onClick={() => decide(e, false)}><X className="size-4" /> Reject</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {open && <ExpenseSheet onClose={() => setOpen(false)} onDone={(approved) => { setOpen(false); load(); toast(approved ? "Expense recorded" : "Expense submitted for approval"); }} />}
    </div>
  );
}

function ExpenseSheet({ onClose, onDone }: { onClose: () => void; onDone: (approved: boolean) => void }) {
  const biz = useBiz();
  const { business } = biz;
  const [section, setSection] = useState<string>(biz.mySections[0]?.id || "");
  const [category, setCategory] = useState("Transport");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayIn(business.timezone));
  const [desc, setDesc] = useState("");
  const [method, setMethod] = useState("Cash");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const auto = section ? biz.canApprove(section) || (biz.role === "manager" && biz.canViewCosts(section)) : biz.isOwner;

  async function save() {
    setErr(null);
    if (!(toMinor(amount) > 0)) return setErr("Enter the amount.");
    setBusy(true);
    const { error } = await supabase().rpc("submit_expense", {
      p_business: business.id, p_section: section || null, p_category: category, p_amount: minorToDecimal(toMinor(amount)), p_date: date,
      p_description: desc || null, p_payment_method: method || null, p_attachment_url: null,
    });
    setBusy(false);
    if (error) setErr(errorMessage(error)); else onDone(auto);
  }
  return (
    <Sheet open onClose={onClose} title={auto ? "Record expense" : "Submit expense claim"} footer={<Button block size="lg" loading={busy} onClick={save}>{auto ? "Save expense" : "Submit for approval"}</Button>}>
      <div className="space-y-3">
        {!auto && <Alert tone="info">Your claim stays <b>pending</b> until an owner approves it.</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount"><MoneyInput value={amount} onChange={setAmount} /></Field>
          <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        <Field label="Category"><Select value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</Select></Field>
        <Field label="Section">
          <Select value={section} onChange={(e) => setSection(e.target.value)}>
            {biz.isOwner && <option value="">Whole business (shared cost)</option>}
            {(biz.isOwner ? biz.sections : biz.mySections).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Paid with"><Select value={method} onChange={(e) => setMethod(e.target.value)}><option>Cash</option><option>MTN Mobile Money</option><option>Orange Money</option><option>Bank</option></Select></Field>
        <Field label="Description"><Textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. Taxi to collect goods from Douala" /></Field>
        {err && <Alert tone="danger">{err}</Alert>}
      </div>
    </Sheet>
  );
}

export default function ExpensesPage() {
  return <Suspense><ExpensesInner /></Suspense>;
}
