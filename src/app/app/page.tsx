"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ShoppingCart, Boxes, Package, Wallet, ClipboardCheck, TriangleAlert, ChevronRight, Upload, Users } from "lucide-react";
import { useBiz } from "@/components/biz";
import { ShiftCard } from "@/components/shift-card";
import { Alert, Badge, Button, Card, Stat } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { fmtMoney } from "@/lib/money";
import { fmtTime, receiptLabel, todayIn } from "@/lib/format";
import type { Product, Report, Sale } from "@/lib/types";
import { PaymentBadge } from "@/components/badges";

function Welcome() {
  const welcome = useSearchParams().get("welcome");
  if (!welcome) return null;
  return (
    <Alert tone="success" title="Your business is ready" className="mb-4">
      Next steps: <Link className="font-semibold underline" href="/app/products/import">import your products</Link>,{" "}
      <Link className="font-semibold underline" href="/app/settings/team">invite your team</Link>, then make your first sale.
    </Alert>
  );
}

export default function Dashboard() {
  const biz = useBiz();
  const { business, role, profile } = biz;
  const [report, setReport] = useState<Report | null>(null);
  const [recent, setRecent] = useState<Sale[]>([]);
  const [low, setLow] = useState<Product[]>([]);
  const [pending, setPending] = useState({ overrides: 0, expenses: 0, reviews: 0 });
  const cur = business.currency;

  useEffect(() => {
    const sb = supabase();
    const today = todayIn(business.timezone);
    sb.rpc("report_summary", { p_business: business.id, p_from: today, p_to: today, p_section: null }).then(({ data }) => setReport(data as Report));
    sb.from("sales").select("*, profiles!sales_staff_user_id_fkey(full_name, email)").eq("business_id", business.id).order("sold_at", { ascending: false }).limit(6)
      .then(({ data }) => setRecent((data || []) as Sale[]));
    if (biz.canManageAny) {
      sb.from("products").select("*").eq("business_id", business.id).eq("active", true).order("stock_qty").limit(200)
        .then(({ data }) => setLow(((data || []) as Product[]).filter((p) => p.stock_qty <= p.low_stock_threshold && biz.hasSection(p.section_id)).slice(0, 6)));
    }
    if (biz.canApproveAny) {
      Promise.all([
        sb.from("price_override_requests").select("id", { count: "exact", head: true }).eq("business_id", business.id).eq("status", "pending"),
        sb.from("expenses").select("id", { count: "exact", head: true }).eq("business_id", business.id).eq("status", "pending"),
        sb.from("sales").select("id", { count: "exact", head: true }).eq("business_id", business.id).eq("status", "pending_review"),
      ]).then(([o, e, r]) => setPending({ overrides: o.count || 0, expenses: e.count || 0, reviews: r.count || 0 }));
    }
  }, [business.id, business.timezone, biz.canManageAny, biz.canApproveAny, biz]);

  const first = (profile?.full_name || "").split(" ")[0];
  const totalPending = pending.overrides + pending.expenses + pending.reviews;
  const isStaff = role === "staff";

  return (
    <div className="space-y-5">
      <Suspense><Welcome /></Suspense>
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Hello{first ? `, ${first}` : ""}</h1>
        <p className="text-sm text-slate-500">Here&apos;s {isStaff ? "your day" : "today at a glance"}.</p>
      </div>

      {role !== "accountant" && (
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <ShiftCard />
          <Link href="/app/pos" className="sm:w-56">
            <Button size="lg" block className="h-full min-h-14 text-lg"><ShoppingCart className="size-6" /> New sale</Button>
          </Link>
        </div>
      )}

      {totalPending > 0 && (
        <Link href="/app/approvals">
          <Card className="flex items-center gap-3 border-amber-300 bg-amber-50 p-4 hover:bg-amber-100">
            <ClipboardCheck className="size-6 text-amber-700" />
            <div className="flex-1">
              <p className="font-semibold text-amber-900">{totalPending} item{totalPending > 1 ? "s" : ""} waiting for your approval</p>
              <p className="text-sm text-amber-800">
                {[pending.overrides && `${pending.overrides} price override${pending.overrides > 1 ? "s" : ""}`,
                  pending.expenses && `${pending.expenses} expense${pending.expenses > 1 ? "s" : ""}`,
                  pending.reviews && `${pending.reviews} offline sale${pending.reviews > 1 ? "s" : ""} to review`].filter(Boolean).join(" · ")}
              </p>
            </div>
            <ChevronRight className="size-5 text-amber-700" />
          </Card>
        </Link>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={isStaff ? "My sales today" : "Sales today"} value={report ? fmtMoney(report.gross_revenue, cur) : "…"} sub={report ? `${report.sales_count} sale${report.sales_count === 1 ? "" : "s"} · ${report.units} item${report.units === 1 ? "" : "s"}` : undefined} />
        <Stat label="Collected" value={report ? fmtMoney(report.collected, cur) : "…"} sub="Cash + mobile money received" />
        <Stat label="Outstanding" value={report ? fmtMoney(report.outstanding, cur) : "…"} tone={report && report.outstanding > 0 ? "warning" : undefined} sub="Customer balances due" />
        {report?.costs_visible
          ? <Stat label="Gross profit" value={fmtMoney(report.gross_profit, cur)} tone="success" sub={report.net_result !== null ? `Net after expenses: ${fmtMoney(report.net_result, cur)}` : undefined} />
          : <Stat label="Avg. sale" value={report && report.sales_count ? fmtMoney(Math.round(report.gross_revenue / report.sales_count), cur) : "—"} />}
      </div>

      {biz.canManageAny && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { href: "/app/inventory/receive", label: "Receive stock", icon: Boxes, show: biz.costsAnywhere },
            { href: "/app/products/edit", label: "Add product", icon: Package, show: true },
            { href: "/app/products/import", label: "Import products", icon: Upload, show: true },
            { href: "/app/expenses?new=1", label: "Record expense", icon: Wallet, show: true },
            { href: "/app/settings/team", label: "Invite team", icon: Users, show: biz.isOwner },
          ].filter((a) => a.show).slice(0, 4).map((a) => (
            <Link key={a.href} href={a.href}>
              <Card className="flex items-center gap-3 p-3 hover:border-brand-200 hover:bg-brand-50">
                <a.icon className="size-5 text-brand" /> <span className="text-sm font-medium">{a.label}</span>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <h2 className="font-semibold">{isStaff ? "My recent sales" : "Recent sales"}</h2>
            <Link href="/app/sales" className="text-sm font-medium text-brand">See all</Link>
          </div>
          {recent.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-500">No sales yet today. Tap <b>New sale</b> to record the first one.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {recent.map((s) => (
                <li key={s.id}>
                  <Link href={`/app/sales/view?id=${s.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{receiptLabel(s.receipt_no)} · {s.customer_name || "Walk-in customer"}</p>
                      <p className="text-xs text-slate-500">{fmtTime(s.sold_at, business.timezone)}{!isStaff && s.profiles ? ` · ${s.profiles.full_name || s.profiles.email}` : ""}</p>
                    </div>
                    <div className="text-right">
                      <p className="tabular text-sm font-semibold">{fmtMoney(s.total, cur)}</p>
                      <PaymentBadge sale={s} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {biz.canManageAny && (
          <Card>
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <h2 className="font-semibold">Low stock</h2>
              <Link href="/app/inventory?filter=low" className="text-sm font-medium text-brand">Inventory</Link>
            </div>
            {low.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-slate-500">All products are above their low-stock level.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {low.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-4 py-3">
                    <TriangleAlert className="size-4 text-amber-600" />
                    <span className="flex-1 truncate text-sm">{p.name}{p.variant_label ? ` (${p.variant_label})` : ""}</span>
                    <Badge tone={p.stock_qty === 0 ? "danger" : "warning"}>{p.stock_qty === 0 ? "Out of stock" : `${p.stock_qty} left`}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
