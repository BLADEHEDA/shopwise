"use client";
import { useState } from "react";
import { Clock } from "lucide-react";
import { useBiz } from "./biz";
import { supabase } from "@/lib/supabase";
import { Button, Card } from "./ui";
import { useToast } from "./toast";
import { duration, errorMessage, fmtTime } from "@/lib/format";

export function ShiftCard({ compact }: { compact?: boolean }) {
  const { shift, business, refreshShift, online } = useBiz();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function clockIn() {
    setBusy(true);
    const { error } = await supabase().rpc("clock_in", { p_business: business.id });
    if (error) toast(errorMessage(error), "error"); else { await refreshShift(); toast("Clocked in. Have a great shift!"); }
    setBusy(false);
  }
  async function clockOut() {
    if (!shift) return;
    if (!confirm("Clock out and end your shift?")) return;
    setBusy(true);
    const { error } = await supabase().rpc("clock_out", { p_shift: shift.id, p_note: null, p_ended_at: null });
    if (error) toast(errorMessage(error), "error"); else { await refreshShift(); toast("Clocked out."); }
    setBusy(false);
  }

  return (
    <Card className={compact ? "flex items-center gap-3 p-3" : "flex items-center gap-4 p-4"}>
      <div className={`grid size-11 shrink-0 place-items-center rounded-xl ${shift ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
        <Clock className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{shift ? "On shift" : "Not clocked in"}</p>
        <p className="text-sm text-slate-500">
          {shift ? `Since ${fmtTime(shift.started_at, business.timezone)} · ${duration(shift.started_at)}` : business.require_shift ? "Clock in before you can record sales" : "Clock in to track your hours"}
        </p>
      </div>
      {shift
        ? <Button variant="secondary" onClick={clockOut} loading={busy} disabled={!online}>Clock out</Button>
        : <Button variant="success" onClick={clockIn} loading={busy} disabled={!online}>Clock in</Button>}
    </Card>
  );
}
