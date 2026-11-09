"use client";
import { useCallback, useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { useBiz } from "@/components/biz";
import { useToast } from "@/components/toast";
import { ShiftCard } from "@/components/shift-card";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Sheet, Spinner } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { fmtMoney } from "@/lib/money";
import { duration, errorMessage, fmtDateTime, fmtTime } from "@/lib/format";
import type { Shift } from "@/lib/types";

interface Row extends Shift { profiles?: { full_name: string | null; email: string | null } | null; sales: number; revenue: number }

export default function ShiftsPage() {
  const biz = useBiz();
  const { business, role, userId } = biz;
  const toast = useToast();
  const manager = ["owner", "section_owner", "manager", "accountant"].includes(role);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [closing, setClosing] = useState<Row | null>(null);
  const cur = business.currency;

  const load = useCallback(async () => {
    const sb = supabase();
    let q = sb.from("shifts").select("*, profiles!shifts_user_id_fkey(full_name, email)").eq("business_id", business.id).order("started_at", { ascending: false }).limit(60);
    if (!manager) q = q.eq("user_id", userId);
    const { data } = await q;
    const shifts = (data || []) as Row[];
    const ids = shifts.map((s) => s.id);
    const totals: Record<string, { n: number; v: number }> = {};
    if (ids.length) {
      const { data: sales } = await sb.from("sales").select("shift_id, total").in("shift_id", ids).eq("status", "completed");
      for (const s of (sales || []) as { shift_id: string; total: number }[]) {
        totals[s.shift_id] = totals[s.shift_id] || { n: 0, v: 0 };
        totals[s.shift_id].n++; totals[s.shift_id].v += Number(s.total);
      }
    }
    setRows(shifts.map((s) => ({ ...s, sales: totals[s.id]?.n || 0, revenue: totals[s.id]?.v || 0 })));
  }, [business.id, manager, userId]);
  useEffect(() => { load(); }, [load, biz.shift?.id]);

  const open = (rows || []).filter((r) => !r.ended_at);
  const closed = (rows || []).filter((r) => r.ended_at);

  return (
    <div className="space-y-4">
      <PageHeader title={manager ? "Staff & shifts" : "My shifts"} subtitle={manager ? "Who is working and what each shift sold" : "Your clock-ins and what you sold"} />
      {role !== "accountant" && <ShiftCard />}

      {rows === null ? <Spinner /> : (
        <>
          {manager && (
            <Card>
              <h2 className="border-b border-slate-100 px-4 py-3 font-semibold">On shift now ({open.length})</h2>
              {open.length === 0 ? <p className="px-4 py-6 text-sm text-slate-500">Nobody is clocked in.</p> : (
                <ul className="divide-y divide-slate-100">
                  {open.map((s) => (
                    <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                      <span className="size-2.5 rounded-full bg-emerald-500" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{s.profiles?.full_name || s.profiles?.email}</p>
                        <p className="text-xs text-slate-500">Since {fmtTime(s.started_at, business.timezone)} · {duration(s.started_at)} · {s.sales} sales · {fmtMoney(s.revenue, cur)}</p>
                      </div>
                      {s.user_id !== userId && role !== "accountant" && <Button size="sm" variant="secondary" onClick={() => setClosing(s)}>Close shift</Button>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
          <Card>
            <h2 className="border-b border-slate-100 px-4 py-3 font-semibold">Recent shifts</h2>
            {closed.length === 0 ? <EmptyState icon={<Clock className="size-6" />} title="No completed shifts yet" /> : (
              <ul className="divide-y divide-slate-100">
                {closed.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{manager ? (s.profiles?.full_name || s.profiles?.email) : fmtDateTime(s.started_at, business.timezone)}</p>
                      <p className="text-xs text-slate-500">
                        {manager ? `${fmtDateTime(s.started_at, business.timezone)} – ` : ""}{fmtTime(s.ended_at, business.timezone)} · {duration(s.started_at, s.ended_at)}
                        {s.note ? ` · ${s.note}` : ""}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="tabular text-sm font-semibold">{fmtMoney(s.revenue, cur)}</p>
                      <p className="text-xs text-slate-500">{s.sales} sale{s.sales === 1 ? "" : "s"}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {manager && <p className="text-xs text-slate-500">{business.require_shift ? "Policy: staff must clock in before selling." : "Policy: sales without a shift are allowed but flagged."} Change this in Settings.</p>}
        </>
      )}
      {closing && <CloseSheet shift={closing} tz={business.timezone} onClose={() => setClosing(null)} onDone={() => { setClosing(null); load(); toast("Shift closed (recorded in audit log)"); }} />}
    </div>
  );
}

function CloseSheet({ shift, tz, onClose, onDone }: { shift: Row; tz: string; onClose: () => void; onDone: () => void }) {
  const [time, setTime] = useState("");
  const [note, setNote] = useState("Forgot to clock out");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setErr(null);
    const { error } = await supabase().rpc("clock_out", { p_shift: shift.id, p_note: note, p_ended_at: time ? new Date(time).toISOString() : new Date().toISOString() });
    setBusy(false);
    if (error) setErr(errorMessage(error)); else onDone();
  }
  return (
    <Sheet open onClose={onClose} title={`Close shift for ${shift.profiles?.full_name || "staff"}`} footer={<Button block size="lg" loading={busy} onClick={save}>Close shift</Button>}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">Started {fmtDateTime(shift.started_at, tz)}.</p>
        <Field label="Actual end time" hint="Leave empty to use now"><Input type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
        <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <Badge tone="info">This correction is recorded in the audit log</Badge>
        {err && <Alert tone="danger">{err}</Alert>}
      </div>
    </Sheet>
  );
}
