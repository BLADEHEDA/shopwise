"use client";
import { useState } from "react";
import { Alert, Button, Field, Sheet, Textarea } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { cx, errorMessage } from "@/lib/format";
import type { Product } from "@/lib/types";

/** Red tag for a price that hasn't been entered yet. */
export function NotSet({ label = "Not set" }: { label?: string }) {
  return <span className="whitespace-nowrap rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-semibold text-red-700 ring-1 ring-red-200">{label}</span>;
}

/** Staff report "running low" / "new stock arrived" to the manager. */
export function FlagSheet({ product, onClose, onDone }: { product: Product; onClose: () => void; onDone: () => void }) {
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

