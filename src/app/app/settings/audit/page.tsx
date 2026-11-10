"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { useBiz } from "@/components/biz";
import { Alert, Card, PageHeader, Spinner } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { fmtDateTime, ROLE_LABEL } from "@/lib/format";
import type { Role } from "@/lib/types";

interface Entry { id: number; actor_id: string | null; action: string; entity: string | null; entity_id: string | null; details: Record<string, unknown>; created_at: string }

const LABEL: Record<string, string> = {
  business_created: "Business created", invitation_created: "Invitation sent", invitation_accepted: "Invitation accepted", invitation_revoked: "Invitation cancelled",
  member_updated: "Role / access changed", price_override_approved: "Price override approved", price_override_rejected: "Price override declined",
  price_override_used: "Approved price used in sale", sale_voided: "Sale voided", offline_sale_conflict: "Offline sale held for review",
  offline_sale_accepted: "Offline sale accepted", offline_sale_rejected: "Offline sale rejected", sale_without_shift: "Sale without shift",
  stock_adjustment: "Stock corrected", stock_damage: "Damage / loss recorded", stock_return: "Return to stock", stock_opening: "Opening stock",
  purchase_received: "Purchase received", cost_price_set: "Cost price changed", product_price_changed: "Product price changed",
  products_imported: "Products imported", expense_approved: "Expense approved", expense_rejected: "Expense rejected",
  shift_closed_by_manager: "Shift closed by manager", brand_changed: "Branding changed",
  member_removed: "Person removed from the shop", member_cost_sections: "Financial access changed", payment_added: "Payment recorded on a sale",
  sale_completed: "Sale completed", feedback_sent: "Feedback sent",
};

export default function AuditPage() {
  const { business, isOwner } = useBiz();
  const [rows, setRows] = useState<Entry[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [roles, setRoles] = useState<Record<string, Role>>({});

  useEffect(() => {
    const sb = supabase();
    sb.from("audit_log").select("*").eq("business_id", business.id).order("created_at", { ascending: false }).limit(300).then(async ({ data }) => {
      const list = (data || []) as Entry[];
      setRows(list);
      const { data: actors } = await sb.rpc("audit_actors", { p_business: business.id });
      const n: Record<string, string> = {}, r: Record<string, Role> = {};
      for (const x of (actors || []) as { user_id: string; name: string; role: Role | null }[]) { n[x.user_id] = x.name; if (x.role) r[x.user_id] = x.role; }
      setNames(n); setRoles(r);
    });
  }, [business.id]);

  if (!isOwner) return <Alert tone="warning">Only owners can view the audit log.</Alert>;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href="/app/settings" className="inline-flex items-center gap-1 text-sm font-medium text-slate-600"><ChevronLeft className="size-4" /> Settings</Link>
      <PageHeader title="Audit log" subtitle="Sensitive actions are recorded automatically and can't be edited." />
      {rows === null ? <Spinner /> : (
        <Card>
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => (
              <li key={r.id} className="px-4 py-3">
                <div className="flex justify-between gap-2">
                  <p className="text-sm font-medium">{LABEL[r.action] || r.action}</p>
                  <p className="shrink-0 text-xs text-slate-500">{fmtDateTime(r.created_at, business.timezone)}</p>
                </div>
                <p className="text-xs text-slate-500">by {r.actor_id ? <><b className="font-semibold text-slate-700">{names[r.actor_id] || "…"}</b> ({roles[r.actor_id] ? ROLE_LABEL[roles[r.actor_id]] : "no longer in the shop"})</> : "the system"}</p>
                {Object.keys(r.details || {}).length > 0 && (
                  <details className="mt-1"><summary className="cursor-pointer text-xs text-brand">Details</summary>
                    <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-50 p-2 text-[11px]">{JSON.stringify(r.details, null, 2)}</pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
