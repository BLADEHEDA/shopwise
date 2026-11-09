"use client";
import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { useBiz } from "@/components/biz";
import { BarChart } from "@/components/bar-chart";
import { Alert, Button, Card, Input, PageHeader, Select, Spinner, Stat } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { fmtMoney, fmtNumber } from "@/lib/money";
import { cx, downloadCsv, errorMessage, fmtDateTime, startOfMonthIn, todayIn } from "@/lib/format";
import type { Report } from "@/lib/types";

type Preset = "today" | "7d" | "month" | "custom";

export default function ReportsPage() {
  const biz = useBiz();
  const { business } = biz;
  const tz = business.timezone;
  const cur = business.currency;
  const [preset, setPreset] = useState<Preset>("7d");
  const [from, setFrom] = useState(todayIn(tz, -6));
  const [to, setTo] = useState(todayIn(tz));
  const [section, setSection] = useState("");
  const [r, setR] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (preset === "today") { setFrom(todayIn(tz)); setTo(todayIn(tz)); }
    if (preset === "7d") { setFrom(todayIn(tz, -6)); setTo(todayIn(tz)); }
    if (preset === "month") { setFrom(startOfMonthIn(tz)); setTo(todayIn(tz)); }
  }, [preset, tz]);

  useEffect(() => {
    setR(null); setErr(null);
    supabase().rpc("report_summary", { p_business: business.id, p_from: from, p_to: to, p_section: section || null })
      .then(({ data, error }) => { if (error) setErr(errorMessage(error)); else setR(data as Report); });
  }, [business.id, from, to, section]);

  const m = (v: number | null | undefined) => fmtMoney(v ?? 0, cur);
  const short = (v: number) => (v >= 1_000_000 ? `${fmtNumber(Math.round(v / 100000) / 10)}M` : v >= 1000 ? `${fmtNumber(Math.round(v / 100) / 10)}k` : fmtNumber(v));
  const own = r?.scope === "own";
  const reportSections = biz.sections.filter((s) => biz.isOwner || biz.hasSection(s.id));

  function exportAll() {
    if (!r) return;
    const rows: (string | number | null)[][] = [["Report", `${from} to ${to}`], [], ["Metric", "Value"],
      ["Gross revenue", r.gross_revenue], ["Sales", r.sales_count], ["Collected", r.collected], ["Outstanding", r.outstanding]];
    if (r.costs_visible) rows.push(["COGS", r.cogs], ["Gross profit", r.gross_profit], ["Approved expenses", r.approved_expenses], ["Net operating result", r.net_result]);
    rows.push([], ["Date", "Revenue", "Sales", ...(r.costs_visible ? ["Gross profit"] : [])], ...r.by_day.map((d) => [d.day, d.revenue, d.sales, ...(r.costs_visible ? [d.profit] : [])]));
    rows.push([], ["Product", "Units", "Revenue", ...(r.costs_visible ? ["Gross profit"] : [])], ...r.by_product.map((p) => [p.name, p.units, p.revenue, ...(r.costs_visible ? [p.profit] : [])]));
    if (!own) rows.push([], ["Staff", "Sales", "Revenue"], ...r.by_staff.map((s) => [s.name, s.sales, s.revenue]));
    rows.push([], ["Payment method", "Collected"], ...r.by_method.map((x) => [x.method, x.amount]));
    downloadCsv(`report-${from}-to-${to}.csv`, rows);
  }

  return (
    <div className="space-y-4">
      <PageHeader title={own ? "My performance" : "Reports"} subtitle={own ? "Your own sales only" : r && !r.costs_visible ? "Revenue view (cost and profit need financial access)" : "Sales, profit, expenses and staff"}
        actions={r && <Button variant="secondary" onClick={exportAll}><Download className="size-4" /> Export CSV</Button>} />

      <Card className="flex flex-wrap items-end gap-2 p-3">
        <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
          {(["today", "7d", "month", "custom"] as Preset[]).map((p) => (
            <button key={p} onClick={() => setPreset(p)} className={cx("rounded-lg px-3 py-1.5 text-sm font-medium", preset === p ? "bg-white shadow-sm" : "text-slate-600")}>
              {{ today: "Today", "7d": "7 days", month: "This month", custom: "Custom" }[p]}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <>
            <Input type="date" className="w-auto" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <Input type="date" className="w-auto" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To" />
          </>
        )}
        {!own && reportSections.length > 1 && (
          <Select className="w-auto" value={section} onChange={(e) => setSection(e.target.value)} aria-label="Section">
            <option value="">{biz.isOwner ? "All sections (consolidated)" : "All my sections"}</option>
            {reportSections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}
      </Card>

      {err && <Alert tone="danger">{err}</Alert>}
      {!r && !err ? <Spinner /> : r && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Gross revenue" value={m(r.gross_revenue)} sub={`${r.sales_count} sales · ${r.units} items`} />
            <Stat label="Collected" value={m(r.collected)} sub="Payments received" />
            <Stat label="Outstanding" value={m(r.outstanding)} tone={r.outstanding > 0 ? "warning" : undefined} sub="Not counted as collected" />
            {r.costs_visible ? <Stat label="COGS" value={m(r.cogs)} sub="Weighted avg. landed cost" /> : <Stat label="Avg. sale" value={r.sales_count ? m(Math.round(r.gross_revenue / r.sales_count)) : "—"} />}
          </div>
          {r.costs_visible && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Gross profit" value={m(r.gross_profit)} tone="success" sub={r.gross_revenue ? `${Math.round(((r.gross_profit || 0) / r.gross_revenue) * 100)}% margin` : undefined} />
              <Stat label="Approved expenses" value={m(r.approved_expenses)} sub={r.pending_expenses ? `${m(r.pending_expenses)} pending (not counted)` : undefined} />
              <Stat label="Net operating result" value={m(r.net_result)} tone={(r.net_result || 0) < 0 ? "danger" : "success"} sub="Gross profit − approved expenses" />
              <Stat label="Avg. sale" value={r.sales_count ? m(Math.round(r.gross_revenue / r.sales_count)) : "—"} />
            </div>
          )}

          <Card className="p-4">
            <h2 className="mb-3 font-semibold">Revenue by day</h2>
            <BarChart label="Revenue" format={short} data={r.by_day.map((d) => ({ x: d.day, y: Number(d.revenue), sub: `${d.sales} sales${d.profit !== null ? ` · profit ${m(d.profit)}` : ""}` }))} />
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <TableCard title="Top products" empty="No products sold" head={["Product", "Units", "Revenue", ...(r.costs_visible ? ["Profit"] : [])]}
              rows={r.by_product.map((p) => [p.name, p.units, m(p.revenue), ...(r.costs_visible ? [m(p.profit)] : [])])} />
            <TableCard title="Payments by method" empty="No payments" head={["Method", "Collected"]} rows={r.by_method.map((x) => [x.method, m(x.amount)])} />
            {!own && <TableCard title="Staff performance" empty="No staff sales" head={["Staff", "Sales", "Revenue"]} rows={r.by_staff.map((s) => [s.name, s.sales, m(s.revenue)])} />}
            {!own && r.by_section.length > 0 && <TableCard title="By section" empty="—" head={["Section", "Revenue", ...(r.costs_visible ? ["Profit"] : [])]} rows={r.by_section.map((s) => [s.name, m(s.revenue), ...(r.costs_visible ? [m(s.profit)] : [])])} />}
            <TableCard title="By shift" empty="No shift sales" head={["Shift", "Sales", "Revenue"]} rows={r.by_shift.map((s) => [`${own ? "" : `${s.name} · `}${fmtDateTime(s.started_at, tz)}`, s.sales, m(s.revenue)])} />
          </div>
          <p className="text-xs text-slate-500">Revenue counts completed sales only (voided and rejected sales are excluded). Collected and outstanding are reported separately from revenue. Profit uses the weighted average landed cost at the time of each sale.</p>
        </>
      )}
    </div>
  );
}

function TableCard({ title, head, rows, empty }: { title: string; head: string[]; rows: (string | number | null)[][]; empty: string }) {
  return (
    <Card>
      <h2 className="border-b border-slate-100 px-4 py-3 font-semibold">{title}</h2>
      {rows.length === 0 ? <p className="px-4 py-6 text-sm text-slate-500">{empty}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500"><tr>{head.map((h, i) => <th key={h} className={cx("px-4 py-2 font-medium", i > 0 && "text-right")}>{h}</th>)}</tr></thead>
            <tbody>{rows.map((row, i) => <tr key={i} className="border-t border-slate-100">{row.map((c, j) => <td key={j} className={cx("px-4 py-2", j > 0 && "tabular whitespace-nowrap text-right")}>{c}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
