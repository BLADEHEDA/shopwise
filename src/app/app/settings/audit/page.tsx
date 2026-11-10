"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { useBiz } from "@/components/biz";
import { Alert, Button, Card, PageHeader, Spinner } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { fmtMoney } from "@/lib/money";
import { errorMessage, fmtDateTime, ROLE_LABEL } from "@/lib/format";
import type { Role } from "@/lib/types";

interface Entry {
  id: number; created_at: string; action: string; entity: string | null; entity_id: string | null;
  details: Record<string, unknown>; actor_name: string | null; actor_role: Role | null; entity_label: string | null; subject_name: string | null;
}
type D = Record<string, unknown>;

const TITLE: Record<string, string> = {
  business_created: "Business created", invitation_created: "Invitation sent", invitation_accepted: "Joined the shop", invitation_revoked: "Invitation cancelled",
  member_updated: "Access changed", member_removed: "Person removed from the shop", member_cost_sections: "Financial access changed", member_team_access: "Team management access changed",
  price_override_approved: "Lower price approved", price_override_rejected: "Lower price declined", price_override_used: "Approved lower price used in a sale",
  sale_voided: "Sale cancelled (voided)", offline_sale_conflict: "Offline sale held for review", offline_sale_accepted: "Offline sale accepted",
  offline_sale_rejected: "Offline sale rejected", sale_without_shift: "Sale made without clocking in", payment_added: "Payment received on an earlier sale",
  stock_adjustment: "Stock corrected", stock_damage: "Damaged / lost stock recorded", stock_return: "Item returned to stock", stock_opening: "Opening stock set",
  purchase_received: "New stock received", cost_price_set: "Cost price changed", product_price_changed: "Selling price changed",
  product_photo_set: "Product photo changed", products_imported: "Products imported", unsold_products_removed: "Unsold products removed",
  expense_approved: "Expense approved", expense_rejected: "Expense rejected", shift_closed_by_manager: "Shift closed by a manager", brand_changed: "App branding changed",
};

const role = (v: unknown) => (typeof v === "string" && v in ROLE_LABEL ? ROLE_LABEL[v as Role] : String(v ?? ""));
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const isUrlOrId = (v: unknown) => typeof v === "string" && (/^https?:\/\//.test(v) || /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v));

/** Turn a log entry into plain sentences a shop owner understands. */
function describe(e: Entry, cur: string, secName: (id: string) => string): string[] {
  const d = (e.details || {}) as D;
  const m = (v: unknown) => (num(v) === null ? "not set" : fmtMoney(num(v)!, cur));
  const what = e.entity_label;
  const before = (d.before || {}) as D, after = (d.after || {}) as D;
  switch (e.action) {
    case "invitation_created": return [`Invited ${d.email} as ${role(d.role)}.`];
    case "invitation_accepted": return [`Joined as ${role(d.role)}.`];
    case "invitation_revoked": return [d.email ? `The invitation for ${d.email} was cancelled.` : "An invitation was cancelled."];
    case "member_removed": return [`${d.name || what || "Someone"} (${role(d.role)}) was removed. Their past sales stay in the history.`];
    case "member_team_access": return [`${what || "This person"} ${d.allowed ? "can now" : "can no longer"} invite, edit and remove people.`];
    case "member_cost_sections": {
      const list = (x: unknown) => (Array.isArray(x) ? x.map((id) => secName(String(id))).join(", ") || "none" : "all their sections");
      return [`${what || "This person"} now sees costs and profit for: ${list(d.after)}.`, `Before: ${list(d.before)}.`];
    }
    case "member_updated": {
      const out: string[] = [];
      const who = what || "This person";
      if (before.role !== after.role) out.push(`${who}: role changed from ${role(before.role)} to ${role(after.role)}.`);
      if (before.active !== after.active) out.push(after.active ? `${who} can sign in again.` : `${who}'s access was turned off (any open shift was closed).`);
      if (before.can_view_costs !== after.can_view_costs) out.push(after.can_view_costs ? `${who} can now see cost prices and profit.` : `${who} can no longer see cost prices and profit.`);
      if (before.all_sections !== after.all_sections) out.push(after.all_sections ? `${who} now works in all sections.` : `${who} now works only in: ${Array.isArray(d.sections) ? d.sections.map((x) => secName(String(x))).join(", ") : "chosen sections"}.`);
      if (before.can_manage_team !== after.can_manage_team && after.can_manage_team !== undefined) out.push(after.can_manage_team ? `${who} can now manage the team.` : `${who} can no longer manage the team.`);
      if (out.length) return out;
      const secs = after.all_sections ? "all sections" : Array.isArray(d.sections) ? d.sections.map((x) => secName(String(x))).join(", ") || "no sections" : "";
      return [`${who}'s access was saved${secs ? ` (works in ${secs})` : ""}; role and rights unchanged.`];
    }
    case "product_price_changed": {
      const out: string[] = [];
      if (before.target !== after.target) out.push(`Target price: ${m(before.target)} → ${m(after.target)}`);
      if (before.min !== after.min) out.push(`Minimum price: ${m(before.min)} → ${m(after.min)}`);
      return [`${what || "A product"}`, ...out];
    }
    case "cost_price_set": return [`${what || "A product"}: cost price ${m(d.before)} → ${m(d.after)}`];
    case "product_photo_set": return [`${what || "A product"}: ${d.before ? "photo replaced" : "photo added"}.`];
    case "products_imported": {
      const parts = [num(d.inserted) ? `${d.inserted} new` : "", num(d.updated) ? `${d.updated} updated` : "", num(d.stock_added) ? `stock added to ${d.stock_added}` : "", num(d.skipped) ? `${d.skipped} skipped (already there)` : ""].filter(Boolean);
      return [`Imported from a file: ${parts.join(", ") || "no changes"}.`];
    }
    case "unsold_products_removed": return [`${d.removed} products removed, ${d.kept} kept because they were already sold.`];
    case "sale_voided": return [`Receipt #${d.receipt_no} for ${m(d.total)} was cancelled. Stock went back on the shelf.`, d.reason ? `Reason: ${d.reason}` : ""].filter(Boolean);
    case "payment_added": return [`${m(d.amount)} received by ${d.method}${d.receipt_no ? ` on receipt #${d.receipt_no}` : what ? ` on ${what}` : ""}.`];
    case "price_override_used": return [`${what ? `${what[0].toUpperCase()}${what.slice(1)}: ` : ""}sold at ${m(d.price)} (minimum is ${m(d.min)}).`];
    case "sale_without_shift": return [`${what ? `${what[0].toUpperCase()}${what.slice(1)}` : "A sale"} was made by someone who wasn't clocked in.`];
    case "offline_sale_conflict": return [`${what ? `${what[0].toUpperCase()}${what.slice(1)}` : "A sale"} made offline needs review (stock or price changed meanwhile).`];
    case "purchase_received": return [`Stock received${what && what !== "purchase" ? ` from ${what}` : ""}: ${d.lines} product line${d.lines === 1 ? "" : "s"}${num(d.extra_costs) ? `, plus ${m(d.extra_costs)} transport/other costs` : ""}.`];
    case "expense_approved": case "expense_rejected":
      return [`${what || "Expense"}${num(d.amount) !== null ? `: ${m(d.amount)}` : ""}${d.note ? ` (note: ${d.note})` : ""}${d.self_recorded ? " (recorded by an owner, approved automatically)" : ""}`];
    case "shift_closed_by_manager": return [`${e.subject_name || what || "A staff member"}'s shift was ended${d.note ? `: ${d.note}` : "."}`];
    case "business_created": return [`${d.name || "The business"} was created.`];
    case "brand_changed": return ["The app's name, colours or logo were changed."];
  }
  if (e.action.startsWith("stock_")) {
    const ch = num(d.change);
    return [`${what || "A product"}: ${ch !== null && ch > 0 ? "+" : ""}${ch} (stock ${d.before} → ${d.after})${d.reason ? `. Reason: ${d.reason}` : ""}`];
  }
  // anything else: readable "label: value" lines, no technical ids or links
  return Object.entries(d).filter(([, v]) => v !== null && v !== "" && typeof v !== "object" && !isUrlOrId(v))
    .map(([k, v]) => `${k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}: ${typeof v === "number" && /price|amount|cost|total|paid/.test(k) ? m(v) : String(v)}`);
}

export default function AuditPage() {
  const { business, sections, canManageTeam } = useBiz();
  const [rows, setRows] = useState<Entry[] | null>(null);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const secName = (id: string) => sections.find((s) => s.id === id)?.name || "a removed section";

  const load = useCallback(async (before?: number) => {
    const { data, error } = await supabase().rpc("audit_feed", { p_business: business.id, p_before: before ?? null, p_limit: 50 });
    if (error) { setErr(errorMessage(error)); setRows((r) => r || []); return; }
    const list = (data || []) as Entry[];
    setRows((r) => (before ? [...(r || []), ...list] : list));
    setMore(list.length === 50);
  }, [business.id]);
  useEffect(() => { load(); }, [load]);

  if (!canManageTeam) return <Alert tone="warning">Only the super admin, or a shop owner allowed to manage the team, can view the audit log.</Alert>;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href="/app/settings" className="inline-flex items-center gap-1 text-sm font-medium text-slate-600"><ChevronLeft className="size-4" /> Settings</Link>
      <PageHeader title="Audit log" subtitle="Who did what, and when. Recorded automatically; nobody can edit it." />
      {err && <Alert tone="danger" title="Couldn't load the log">{/function|schema/i.test(err) ? "The database hasn't received the latest update yet. In Vercel, check DATABASE_URL, then redeploy." : err}</Alert>}
      {rows === null ? <Spinner /> : rows.length === 0 && !err ? <Card className="p-6 text-center text-sm text-slate-500">Nothing recorded yet.</Card> : (
        <Card>
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => (
              <li key={r.id} className="px-4 py-3">
                <div className="flex justify-between gap-3">
                  <p className="font-semibold text-ink">{TITLE[r.action] || r.action.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}</p>
                  <p className="shrink-0 text-xs text-slate-500">{fmtDateTime(r.created_at, business.timezone)}</p>
                </div>
                <p className="text-sm text-slate-600">
                  by {r.actor_name ? <b className="font-semibold text-slate-800">{r.actor_name}</b> : "the system"}
                  {r.actor_name && <span className="text-slate-500"> ({r.actor_role ? ROLE_LABEL[r.actor_role] : "no longer in the shop"})</span>}
                </p>
                <ul className="mt-1 space-y-0.5 text-sm text-slate-700">
                  {describe(r, business.currency, secName).map((l, i) => <li key={i}>{l}</li>)}
                </ul>
              </li>
            ))}
          </ul>
          {more && <div className="border-t border-slate-100 p-3 text-center"><Button variant="ghost" onClick={() => load(rows[rows.length - 1].id)}>Show older</Button></div>}
        </Card>
      )}
    </div>
  );
}
