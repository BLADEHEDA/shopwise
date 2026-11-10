"use client";
import { useState } from "react";
import { useDialog } from "@/components/dialog";
import { CircleCheck, CircleX } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { errorMessage } from "@/lib/format";
import type { Sale } from "@/lib/types";
import { Button } from "./ui";
import { useToast } from "./toast";

export function ReviewActions({ sale, onDone }: { sale: Sale; onDone: () => void }) {
  const toast = useToast();
  const dialog = useDialog();
  const [busy, setBusy] = useState<"a" | "r" | null>(null);
  async function decide(accept: boolean) {
    const reason = accept ? "Accepted after review" : await dialog.prompt({ title: "Reject this sale?", message: "Stock will not be deducted. The shopkeeper sees your reason.", label: "Why are you rejecting it?", placeholder: "e.g. item was out of stock", required: true, confirmLabel: "Reject sale", tone: "danger" });
    if (!accept && !reason) return;
    setBusy(accept ? "a" : "r");
    const { error } = await supabase().rpc("resolve_sale_review", { p_sale: sale.id, p_accept: accept, p_reason: reason });
    setBusy(null);
    if (error) toast(errorMessage(error), "error"); else { toast(accept ? "Sale accepted and stock updated" : "Sale rejected"); onDone(); }
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      <Button variant="success" loading={busy === "a"} onClick={() => decide(true)}><CircleCheck className="size-4" /> Accept</Button>
      <Button variant="danger" loading={busy === "r"} onClick={() => decide(false)}><CircleX className="size-4" /> Reject</Button>
    </div>
  );
}

