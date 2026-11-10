"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useDialog } from "@/components/dialog";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Receipt, Search, CloudUpload, RefreshCw, Trash2 } from "lucide-react";
import { useBiz } from "@/components/biz";
import { PaymentBadge } from "@/components/badges";
import { Alert, Badge, Button, Card, EmptyState, Input, PageHeader, Spinner, Tabs } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { db, discardItem, onQueueChange, retryItem, type QueuedSale } from "@/lib/offline";
import { fmtMoney } from "@/lib/money";
import { cx, fmtDateTime, receiptLabel, startOfMonthIn, todayIn } from "@/lib/format";

const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
import type { Sale } from "@/lib/types";

type Tab = "all" | "paid" | "due" | "review" | "voided" | "queue";

function SalesInner() {
  const biz = useBiz();
  const { business } = biz;
  const initial = (useSearchParams().get("tab") as Tab) || "all";
  const [tab, setTab] = useState<Tab>(initial);
  const [from, setFrom] = useState(todayIn(business.timezone, -6));
  const [to, setTo] = useState(todayIn(business.timezone));
  const tz = business.timezone;
  const today = todayIn(tz);
  const presets = [
    { label: "Today", from: today, to: today },
    { label: "Yesterday", from: todayIn(tz, -1), to: todayIn(tz, -1) },
    { label: "Last 7 days", from: todayIn(tz, -6), to: today },
    { label: "This month", from: startOfMonthIn(tz), to: today },
    { label: "Last 30 days", from: todayIn(tz, -29), to: today },
  ];
  const [q, setQ] = useState("");
  const [sales, setSales] = useState<Sale[] | null>(null);
  const [queue, setQueue] = useState<QueuedSale[]>([]);
  const cur = business.currency;

  const readQueue = useCallback(async () => {
    try { setQueue((await db().queue.toArray()).filter((x) => x.business_id === business.id)); } catch {}
  }, [business.id]);
  useEffect(() => { readQueue(); return onQueueChange(readQueue); }, [readQueue]);

  useEffect(() => {
    if (tab === "queue") return;
    setSales(null);
    let query = supabase().from("sales").select("*, profiles!sales_staff_user_id_fkey(full_name, email)").eq("business_id", business.id).order("sold_at", { ascending: false }).limit(300);
    if (tab === "paid") query = query.eq("payment_status", "paid").eq("status", "completed");
    else if (tab === "due") query = query.in("payment_status", ["partial", "unpaid"]).eq("status", "completed");
    else if (tab === "review") query = query.eq("status", "pending_review");
    else if (tab === "voided") query = query.in("status", ["voided", "rejected"]);
    if (tab === "all" || tab === "paid" || tab === "voided") {
      // widen by a day on each side, then filter exactly by business-local date below
      const start = new Date(`${from}T00:00:00Z`);
      const end = new Date(`${to}T23:59:59Z`);
      query = query.gte("sold_at", new Date(start.getTime() - 86400000).toISOString()).lte("sold_at", new Date(end.getTime() + 86400000).toISOString());
    }
    query.then(({ data }) => {
      let rows = (data || []) as Sale[];
      if (tab === "all" || tab === "paid" || tab === "voided") {
        rows = rows.filter((s) => { const d = todayFromIso(s.sold_at, business.timezone); return d >= from && d <= to; });
      }
      setSales(rows);
    });
  }, [tab, from, to, business.id, business.timezone]);

  const s = q.trim().toLowerCase();
  const filtered = (sales || []).filter((x) => !s || receiptLabel(x.receipt_no).includes(s) || String(x.receipt_no).includes(s) || (x.customer_name || "").toLowerCase().includes(s) || (x.customer_phone || "").includes(s));
  const sum = filtered.filter((x) => x.status === "completed").reduce((a, x) => a + Number(x.total), 0);

  return (
    <div>
      <PageHeader title="Sales" subtitle={biz.role === "staff" ? "Your sales" : "All sales you have access to"} actions={<Link href="/app/pos"><Button>New sale</Button></Link>} />
      <Tabs value={tab} onChange={setTab} items={[
        { value: "all", label: "All" },
        { value: "paid", label: "Fully paid" },
        { value: "due", label: "Part paid / owing" },
        { value: "review", label: "Needs review" },
        { value: "voided", label: "Voided" },
        { value: "queue", label: <>Offline queue {queue.length > 0 && <Badge tone="warning">{queue.length}</Badge>}</> },
      ]} />

      {tab === "queue" ? (
        <QueueList queue={queue} cur={cur} />
      ) : (
        <>
          <div className="mb-3 space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <Input className="pl-9" placeholder="Search receipt number, customer name or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search sales" />
            </div>
            {(tab === "all" || tab === "paid" || tab === "voided") && (
              <div className="rounded-2xl border border-slate-200 bg-white p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Period</p>
                <div className="mb-3 flex gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none]" role="group" aria-label="Quick periods">
                  {presets.map((p) => {
                    const on = from === p.from && to === p.to;
                    return (
                      <button key={p.label} type="button" onClick={() => { setFrom(p.from); setTo(p.to); }} aria-pressed={on}
                        className={cx("h-9 shrink-0 rounded-full border px-3 text-sm font-medium", on ? "border-brand bg-brand text-white" : "border-slate-300 bg-white text-slate-700 hover:border-brand")}>
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                <div className="grid grid-cols-2 gap-2 sm:max-w-md">
                  <label className="text-xs font-medium text-slate-600">From (start date)
                    <Input type="date" className="mt-1" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
                  </label>
                  <label className="text-xs font-medium text-slate-600">To (end date)
                    <Input type="date" className="mt-1" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
                  </label>
                </div>
                <p className="mt-2 text-xs text-slate-500">Showing sales from <b className="text-ink">{fmtDay(from)}</b> to <b className="text-ink">{fmtDay(to)}</b>{from === to ? " (one day)" : ""}.</p>
              </div>
            )}
          </div>
          {sales === null ? <Spinner /> : filtered.length === 0 ? (
            <EmptyState icon={<Receipt className="size-6" />} title="No sales here">
              {tab === "due" ? "No customer owes money right now." : tab === "review" ? "No offline sales are waiting for review." : "Try a different date range."}
            </EmptyState>
          ) : (
            <Card>
              <div className="flex justify-between border-b border-slate-100 px-4 py-2.5 text-sm text-slate-600">
                <span>{filtered.length} sale{filtered.length === 1 ? "" : "s"}</span>
                {tab !== "voided" && <span>Total <b className="tabular text-ink">{fmtMoney(sum, cur)}</b></span>}
                {tab === "due" && <span>Customers owe <b className="tabular text-amber-700">{fmtMoney(filtered.reduce((t, x) => t + Number(x.balance_due), 0), cur)}</b></span>}
              </div>
              <ul className="divide-y divide-slate-100">
                {filtered.map((x) => (
                  <li key={x.id}>
                    <Link href={`/app/sales/view?id=${x.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold">{receiptLabel(x.receipt_no)} · {x.customer_name || "Walk-in customer"}</p>
                        <p className="truncate text-xs text-slate-500">
                          {fmtDateTime(x.sold_at, business.timezone)}
                          {biz.role !== "staff" && x.profiles ? ` · ${x.profiles.full_name || x.profiles.email}` : ""}
                          {x.offline ? " · synced from offline" : ""}{x.no_shift ? " · no shift" : ""}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="tabular text-sm font-semibold">{fmtMoney(x.total, cur)}</p>
                        {x.balance_due > 0 && x.status === "completed" && <p className="tabular text-xs font-medium text-amber-700">Due {fmtMoney(x.balance_due, cur)}</p>}
                        <PaymentBadge sale={x} />
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function todayFromIso(iso: string, tz: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

function QueueList({ queue, cur }: { queue: QueuedSale[]; cur: string }) {
  const dialog = useDialog();
  const [busy, setBusy] = useState<string | null>(null);
  if (!queue.length) {
    return <EmptyState icon={<CloudUpload className="size-6" />} title="Nothing waiting to sync">Sales made without internet appear here until they reach the server.</EmptyState>;
  }
  return (
    <div className="space-y-3">
      <Alert tone="info">These sales are saved on this phone only. They sync automatically when you&apos;re online. Don&apos;t clear the browser data until they&apos;re gone from this list.</Alert>
      {queue.map((item) => (
        <Card key={item.client_tx_id} className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold">{item.display.customer || "Walk-in customer"} · {fmtMoney(item.display.total, cur)}</p>
              <p className="text-xs text-slate-500">{new Date(item.created_at).toLocaleString()} · ref {item.client_tx_id.slice(0, 8)}</p>
              <p className="mt-1 text-sm text-slate-600">{item.display.lines.map((l) => `${l.quantity}× ${l.name}`).join(", ")}</p>
            </div>
            {item.status === "error" ? <Badge tone="danger">Failed</Badge> : item.status === "syncing" ? <Badge tone="info">Syncing</Badge> : <Badge tone="warning">Pending</Badge>}
          </div>
          {item.status === "error" && (
            <>
              <Alert tone="danger" className="mt-3">{item.error}</Alert>
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="secondary" loading={busy === item.client_tx_id} onClick={async () => { setBusy(item.client_tx_id); await retryItem(item.client_tx_id); setBusy(null); }}><RefreshCw className="size-4" /> Retry</Button>
                <Button size="sm" variant="ghost" onClick={async () => { if (await dialog.confirm({ title: "Discard this offline sale?", message: "It will not be recorded and stock will not change.", confirmLabel: "Discard", tone: "danger" })) discardItem(item.client_tx_id); }}><Trash2 className="size-4" /> Discard</Button>
              </div>
            </>
          )}
        </Card>
      ))}
    </div>
  );
}

export default function SalesPage() {
  return <Suspense><SalesInner /></Suspense>;
}
