"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  House, ShoppingCart, Receipt, Package, Boxes, Clock, Wallet, ClipboardCheck, ChartColumn, Settings, Menu, LogOut, MessageSquarePlus, FlaskConical,
} from "lucide-react";
import { useBiz } from "./biz";
import { BrandMark, useBrand } from "@/lib/brand";
import { SyncIndicator } from "./sync-indicator";
import { supabase } from "@/lib/supabase";
import { cx, ROLE_LABEL } from "@/lib/format";
import { Sheet } from "./ui";

interface NavItem { href: string; label: string; icon: React.ComponentType<{ className?: string }>; badge?: number; show: boolean }

function usePendingApprovals() {
  const { business, canApproveAny } = useBiz();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!canApproveAny) return;
    let alive = true;
    const read = async () => {
      const sb = supabase();
      const [o, e, s] = await Promise.all([
        sb.from("price_override_requests").select("id", { count: "exact", head: true }).eq("business_id", business.id).eq("status", "pending"),
        sb.from("expenses").select("id", { count: "exact", head: true }).eq("business_id", business.id).eq("status", "pending"),
        sb.from("sales").select("id", { count: "exact", head: true }).eq("business_id", business.id).eq("status", "pending_review"),
      ]);
      if (alive) setN((o.count || 0) + (e.count || 0) + (s.count || 0));
    };
    read();
    const t = setInterval(read, 15000);
    return () => { alive = false; clearInterval(t); };
  }, [business.id, canApproveAny]);
  return n;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const biz = useBiz();
  const { brand } = useBrand();
  const path = usePathname();
  const [more, setMore] = useState(false);
  const approvals = usePendingApprovals();
  const sells = biz.role !== "accountant";

  const items: NavItem[] = [
    { href: "/app", label: "Home", icon: House, show: true },
    { href: "/app/pos", label: "New sale", icon: ShoppingCart, show: sells },
    { href: "/app/sales", label: "Sales", icon: Receipt, show: true },
    { href: "/app/products", label: "Products", icon: Package, show: true },
    { href: "/app/inventory", label: "Inventory", icon: Boxes, show: biz.role !== "staff" },
    { href: "/app/shifts", label: biz.role === "staff" ? "My shifts" : "Staff & shifts", icon: Clock, show: true },
    { href: "/app/expenses", label: "Expenses", icon: Wallet, show: true },
    { href: "/app/approvals", label: "Approvals", icon: ClipboardCheck, badge: approvals, show: biz.canApproveAny },
    { href: "/app/reports", label: biz.role === "staff" ? "My performance" : "Reports", icon: ChartColumn, show: true },
    { href: "/app/settings", label: "Settings", icon: Settings, show: true },
    { href: `/app/feedback?from=${encodeURIComponent(path)}`, label: "Feedback", icon: MessageSquarePlus, show: true },
  ].filter((i) => i.show);

  const active = (href: string) => (href === "/app" ? path === "/app" : path.startsWith(href.split("?")[0]));
  const bottom = items.filter((i) => ["/app", "/app/pos", "/app/sales", biz.canApproveAny ? "/app/approvals" : "/app/products"].includes(i.href));

  useEffect(() => { document.title = `${biz.business.name} · ${brand.product_name}`; }, [biz.business.name, brand.product_name]);

  return (
    <div className="min-h-dvh lg:flex">
      {/* desktop sidebar */}
      <aside className="no-print sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex">
        <div className="px-5 py-5"><BrandMark size={32} /></div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3">
          {items.map((i) => (
            <Link key={i.href} href={i.href} className={cx("flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] font-medium",
              active(i.href) ? "bg-brand-50 text-brand-700" : "text-slate-700 hover:bg-slate-100")}>
              <i.icon className="size-5" /> <span className="flex-1">{i.label}</span>
              {!!i.badge && <span className="rounded-full bg-red-600 px-1.5 text-xs font-bold text-white">{i.badge}</span>}
            </Link>
          ))}
        </nav>
        <div className="border-t border-slate-100 p-4 text-sm">
          <p className="truncate font-medium">{biz.profile?.full_name || biz.session.user.email}</p>
          <p className="text-xs text-slate-500">{ROLE_LABEL[biz.role]}</p>
          <button onClick={() => supabase().auth.signOut()} className="mt-2 inline-flex items-center gap-1.5 text-slate-600 hover:text-ink">
            <LogOut className="size-4" /> Sign out
          </button>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="no-print sticky top-0 z-30 flex items-center gap-3 border-b border-slate-200 bg-white/95 px-4 py-2.5 backdrop-blur">
          <div className="min-w-0 flex-1">
            {biz.memberships.length > 1 ? (
              <select aria-label="Switch business" value={biz.business.id} onChange={(e) => biz.setBusiness(e.target.value)}
                className="max-w-full truncate bg-transparent text-[15px] font-semibold focus:outline-none">
                {biz.memberships.map((m) => <option key={m.business_id} value={m.business_id}>{m.businesses?.name}</option>)}
              </select>
            ) : (
              <p className="truncate text-[15px] font-semibold">{biz.business.name}</p>
            )}
            <p className="text-xs text-slate-500">
              {ROLE_LABEL[biz.role]}{biz.shift ? " · On shift" : ""}
            </p>
          </div>
          <SyncIndicator businessId={biz.business.id} />
        </header>

        {biz.business.is_demo && (
          <div className="no-print flex items-center gap-2 bg-amber-100 px-4 py-2 text-sm text-amber-900">
            <FlaskConical className="size-4 shrink-0" />
            <span className="flex-1">Demo shop: test data shared by all testers. Try anything; it gets reset.</span>
            <Link href={`/app/feedback?from=${encodeURIComponent(path)}`} className="shrink-0 font-semibold underline">Give feedback</Link>
          </div>
        )}
        <main className="mx-auto w-full max-w-6xl px-4 pb-28 pt-4 lg:px-8 lg:pb-10">
          {biz.isOwner && <SchemaCheck />}
          {children}
        </main>
      </div>

      {/* mobile bottom navigation */}
      <nav className="no-print safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white lg:hidden" aria-label="Main">
        <div className="grid grid-cols-5">
          {bottom.map((i) => (
            <Link key={i.href} href={i.href} className={cx("relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium",
              active(i.href) ? "text-brand" : "text-slate-500")}>
              {i.href === "/app/pos" ? (
                <span className="-mt-5 grid size-12 place-items-center rounded-2xl bg-brand text-white shadow-lg shadow-brand/30"><i.icon className="size-6" /></span>
              ) : <i.icon className="size-6" />}
              {i.href === "/app/pos" ? "Sell" : i.label}
              {!!i.badge && <span className="absolute right-[22%] top-1 rounded-full bg-red-600 px-1.5 text-[10px] font-bold text-white">{i.badge}</span>}
            </Link>
          ))}
          <button onClick={() => setMore(true)} className="flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-slate-500">
            <Menu className="size-6" /> More
          </button>
        </div>
      </nav>

      <Sheet open={more} onClose={() => setMore(false)} title="Menu">
        <div className="grid grid-cols-3 gap-2">
          {items.map((i) => (
            <Link key={i.href} href={i.href} onClick={() => setMore(false)}
              className={cx("relative flex flex-col items-center gap-1.5 rounded-2xl border p-3 text-center text-xs font-medium",
                active(i.href) ? "border-brand-200 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-700")}>
              <i.icon className="size-6" /> {i.label}
              {!!i.badge && <span className="absolute right-2 top-2 rounded-full bg-red-600 px-1.5 text-[10px] font-bold text-white">{i.badge}</span>}
            </Link>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between rounded-2xl bg-slate-50 p-3 text-sm">
          <div className="min-w-0">
            <p className="truncate font-medium">{biz.profile?.full_name || biz.session.user.email}</p>
            <p className="text-xs text-slate-500">{ROLE_LABEL[biz.role]}</p>
          </div>
          <button onClick={() => supabase().auth.signOut()} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 font-medium text-slate-700 hover:bg-slate-200">
            <LogOut className="size-4" /> Sign out
          </button>
        </div>
      </Sheet>
    </div>
  );
}

/** The app expects this database version (supabase/migrations/00NN_*.sql).
 *  Upgrades run automatically on each Vercel deploy when DATABASE_URL is set;
 *  if they didn't, tell the super admin instead of failing silently. */
const EXPECTED_SCHEMA = 9;
function SchemaCheck() {
  const [have, setHave] = useState<number | null>(null);
  const [fail, setFail] = useState<{ last_failed: string | null; last_error: string | null } | null>(null);
  useEffect(() => {
    let off = false;
    const sb = supabase();
    sb.rpc("shopwise_schema").then(({ data, error }) => {
      if (off) return;
      const v = error ? 0 : Number(data);
      setHave(v);
      if (v < EXPECTED_SCHEMA) sb.rpc("shopwise_migration_status").then(({ data: st }) => {
        const row = Array.isArray(st) ? st[0] : null;
        if (!off && row?.last_error) setFail(row);
      });
    });
    return () => { off = true; };
  }, []);
  if (have === null || have >= EXPECTED_SCHEMA) return null;
  return (
    <div role="alert" className="mb-4 rounded-2xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <b>Your database is missing the latest update</b> (version {have || "8 or older"}, needs {EXPECTED_SCHEMA}). Some features won&apos;t work until it&apos;s applied.{" "}
      {fail ? (
        <>The upgrade <b>{fail.last_failed}</b> failed with: <code className="break-words rounded bg-white px-1">{fail.last_error}</code>. Send a screenshot of this to your developer.</>
      ) : (
        <>In Vercel → Settings → Environment Variables, make sure <code className="rounded bg-white px-1">DATABASE_URL</code> is set (Supabase → Connect → Direct → Session pooler), then Redeploy. The build log lines starting with <code className="rounded bg-white px-1">[migrate]</code> say what happened.</>
      )}
    </div>
  );
}
