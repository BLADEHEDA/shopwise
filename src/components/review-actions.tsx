"use client";
import { useState } from "react";
import { CircleCheck, CircleX } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { errorMessage } from "@/lib/format";
import type { Sale } from "@/lib/types";
import { Button } from "./ui";
import { useToast } from "./toast";

export function ReviewActions({ sale, onDone }: { sale: Sale; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<"a" | "r" | null>(null);
  async function decide(accept: boolean) {
    const reason = accept ? "Accepted after review" : prompt("Why are you rejecting this sale? (e.g. item was out of stock)") || "";
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

