"use client";
import { Fragment, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Boxes, Search, History, SlidersHorizontal, Flag, Truck, Check, Upload, Download, MoreVertical } from "lucide-react";
import { useBiz } from "@/components/biz";
import { useToast } from "@/components/toast";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, MoneyInput, PageHeader, Select, Sheet, Spinner, Tabs, Textarea } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { fmtMoney, fmtNumber, minorToDecimal, toMinor } from "@/lib/money";
import { cx, downloadCsv, errorMessage, fmtDate, fmtDateTime } from "@/lib/format";
import type { Product } from "@/lib/types";
import { FlagSheet, NotSet } from "@/components/stock-bits";

interface Movement { id: string; product_id: string; kind: string; qty_change: number; balance_after: number; reason: string | null; ref_type: string | null; ref_id: string | null; created_at: string; profiles?: { full_name: string | null } | null; products?: { name: string; variant_label: string | null } | null }
interface StockFlag { id: string; product_id: string; kind: "low" | "arrived"; note: string | null; created_at: string; resolved_at: string | null; products?: { name: string } | null; profiles?: { full_name: string | null } | null }
interface Purchase { id: string; purchase_date: string; source: string; currency: string; exchange_rate: number; freight_cost: number; other_costs: number; allocation_method: string; reference: string | null; section_id: string; suppliers?: { name: string } | null; purchase_lines?: { quantity: number; unit_price: number; landed_unit_cost: number; allocated_extra: number; products?: { name: string } | null }[] }

const KIND_LABEL: Record<string, string> = { opening: "Opening stock", purchase: "Purchase received", sale: "Sale", return: "Return", adjustment: "Adjustment", damage: "Damage / loss", transfer: "Transfer", void: "Sale voided", review_accept: "Offline sale accepted" };

type Tab = "levels" | "movements" | "purchases" | "flags";

function InventoryInner() {
  const biz = useBiz();
  const { business } = biz;
  const params = useSearchParams();
  const toast = useToast();
  const cur = business.currency;
  const [tab, setTab] = useState<Tab>("levels");
  const [products, setProducts] = useState<Product[] | null>(null);
  const [costs, setCosts] = useState<Record<string, number>>({});
  const [adjust, setAdjust] = useState<Product | null>(null);
  const [history, setHistory] = useState<Product | null>(null);
  const [flagFor, setFlagFor] = useState<Product | null>(null);
  const router = useRouter();
  const staff = biz.role === "staff";
  // Shopkeepers don't see Inventory; they use Products.
  useEffect(() => { if (staff) router.replace("/app/products"); }, [staff, router]);

  const { hasSection, costsAnywhere } = biz;
  const load = useCallback(() => {
    const sb = supabase();
    // each person only sees the inventory of their own sections (Super admin: all)
    sb.from("products").select("*, categories(name)").eq("business_id", business.id).eq("active", true).order("name")
      .then(({ data }) => setProducts(((data || []) as Product[]).filter((p) => hasSection(p.section_id))));
    if (costsAnywhere) sb.from("product_costs").select("product_id, avg_cost").eq("business_id", business.id).then(({ data }) => {
      const m: Record<string, number> = {}; for (const r of (data || []) as { product_id: string; avg_cost: number }[]) m[r.product_id] = r.avg_cost; setCosts(m);
    });
  }, [business.id, costsAnywhere, hasSection]);
  useEffect(load, [load]);


  const tabs: { value: Tab; label: string }[] = [{ value: "levels", label: "Stock levels" }];
  if (biz.canManageAny || biz.canReport) tabs.push({ value: "movements", label: "Movement history" });
  if (biz.costsAnywhere) tabs.push({ value: "purchases", label: "Purchase batches" });
  if (biz.canManageAny) tabs.push({ value: "flags", label: "Staff reports" });

  return (
    <div>
      <PageHeader title="Inventory" subtitle={biz.canManageAny ? "Stock levels, adjustments and history" : "Check stock and report low or arrived items"}
        actions={biz.canManageAny && (
          <>
            <Link href="/app/products/import?mode=stock"><Button variant="secondary"><Upload className="size-4" /> Import stock</Button></Link>
            {biz.costsAnywhere && <Link href="/app/inventory/receive"><Button><Truck className="size-4" /> Receive stock</Button></Link>}
          </>
        )} />
      {tabs.length > 1 && <Tabs value={tab} onChange={setTab} items={tabs} />}

      {staff ? <Spinner /> : tab === "levels" && (products === null ? <Spinner /> : (
        <StockTable products={products} costs={costs} lowFirst={params.get("filter") === "low"}
          onAdjust={setAdjust} onHistory={setHistory} onFlag={setFlagFor} />
      ))}

      {tab === "movements" && <Movements />}
      {tab === "purchases" && <Purchases cur={cur} />}
      {tab === "flags" && <Flags />}

      {adjust && <AdjustSheet product={adjust} onClose={() => setAdjust(null)} onDone={() => { setAdjust(null); load(); toast("Stock updated"); }} />}
      {history && <HistorySheet product={history} onClose={() => setHistory(null)} />}
      {flagFor && <FlagSheet product={flagFor} onClose={() => setFlagFor(null)} onDone={() => { setFlagFor(null); toast("Thanks, the manager has been notified"); }} />}
    </div>
  );
}


type SortKey = "category" | "name" | "amount" | "quantity";
type Row = Product & { cost: number | null; amount: number | null; sellValue: number | null; minValue: number | null };

/** Excel-like stock table: Item | Cost price | Quantity | Amount (cost x quantity),
 *  grouped by category with subtotals, totals at the top. No images here:
 *  photos live in Products. */
function StockTable({ products, costs, lowFirst, onAdjust, onHistory, onFlag }: {
  products: Product[]; costs: Record<string, number>; lowFirst: boolean;
  onAdjust: (p: Product) => void; onHistory: (p: Product) => void; onFlag: (p: Product) => void;
}) {
  const biz = useBiz();
  const { business } = biz;
  const sections = biz.sections.filter((s) => biz.hasSection(s.id));
  const cur = business.currency;
  const [q, setQ] = useState("");
  const [section, setSection] = useState("all");
  const [category, setCategory] = useState("all");
  const [lowOnly, setLowOnly] = useState(lowFirst);
  const [sort, setSort] = useState<SortKey>("category");
  const [showSell, setShowSellState] = useState(true);
  useEffect(() => { try { if (localStorage.getItem("shopwise.inv.prices") === "0") setShowSellState(false); } catch { /* private mode */ } }, []);
  const setShowSell = (v: boolean) => { setShowSellState(v); try { localStorage.setItem("shopwise.inv.prices", v ? "1" : "0"); } catch { /* private mode */ } };
  const [menu, setMenu] = useState<Row | null>(null);
  const seeCosts = biz.costsAnywhere;

  const rows: Row[] = useMemo(() => products.map((p) => {
    const c = biz.canViewCosts(p.section_id) ? costs[p.id] : undefined;
    const cost = c !== undefined && c > 0 ? c : null;
    return { ...p, cost, amount: cost !== null ? (toMinor(cost) * p.stock_qty) / 100 : null,
      sellValue: p.target_price !== null ? (toMinor(p.target_price) * p.stock_qty) / 100 : null,
      minValue: p.min_price !== null ? (toMinor(p.min_price) * p.stock_qty) / 100 : null };
  }), [products, costs, biz]);

  const categories = useMemo(() => Array.from(new Set(rows.map((r) => r.categories?.name || "No category"))).sort((a, b) => a.localeCompare(b)), [rows]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const out = rows.filter((p) => (section === "all" || p.section_id === section)
      && (category === "all" || (p.categories?.name || "No category") === category)
      && (!lowOnly || p.stock_qty <= p.low_stock_threshold)
      && (!s || [p.name, p.brand, p.model, p.sku, p.variant_label, p.categories?.name].some((v) => v && v.toLowerCase().includes(s))));
    const byName = (a: Row, b: Row) => a.name.localeCompare(b.name);
    if (sort === "name") out.sort(byName);
    else if (sort === "amount") out.sort((a, b) => (b.amount ?? -1) - (a.amount ?? -1) || byName(a, b));
    else if (sort === "quantity") out.sort((a, b) => b.stock_qty - a.stock_qty || byName(a, b));
    else out.sort((a, b) => (a.categories?.name || "~").localeCompare(b.categories?.name || "~") || byName(a, b));
    return out;
  }, [rows, q, section, category, lowOnly, sort]);

  const sum = (rs: Row[]) => ({
    qty: rs.reduce((a, r) => a + r.stock_qty, 0),
    amount: rs.reduce((a, r) => a + toMinor(r.amount ?? 0), 0) / 100,
    sell: rs.reduce((a, r) => a + toMinor(r.sellValue ?? 0), 0) / 100,
    min: rs.reduce((a, r) => a + toMinor(r.minValue ?? 0), 0) / 100,
    // profit only where both cost and target are known
    profit: rs.reduce((a, r) => a + (r.amount !== null && r.sellValue !== null ? toMinor(r.sellValue) - toMinor(r.amount) : 0), 0) / 100,
    noCost: rs.filter((r) => r.cost === null && r.stock_qty > 0).length,
    noPrice: rs.filter((r) => r.target_price === null && r.stock_qty > 0).length,
    low: rs.filter((r) => r.stock_qty <= r.low_stock_threshold).length,
  });
  const total = sum(list);
  const filtered = list.length !== rows.length;

  const groups: { name: string; rows: Row[] }[] = [];
  if (sort === "category") for (const r of list) {
    const n = r.categories?.name || "No category";
    const g = groups[groups.length - 1];
    if (g && g.name === n) g.rows.push(r); else groups.push({ name: n, rows: [r] });
  } else groups.push({ name: "", rows: list });

  const colCount = 3 + (seeCosts ? 2 : 0) + (showSell ? 2 : 0);
  const money = (v: number | null) => (v === null ? "—" : fmtMoney(v, cur));

  function exportCsv() {
    const head = ["Category", "Item", ...(seeCosts ? ["Cost price"] : []), "Quantity", ...(seeCosts ? ["Amount"] : []), ...(showSell ? ["Min price", "Target price", "Value at min", "Value at target"] : [])];
    const line = (r: Row) => [r.categories?.name || "", r.name + (r.variant_label ? ` (${r.variant_label})` : ""), ...(seeCosts ? [r.cost ?? ""] : []), r.stock_qty, ...(seeCosts ? [r.amount ?? ""] : []), ...(showSell ? [r.min_price ?? "", r.target_price ?? "", r.minValue ?? "", r.sellValue ?? ""] : [])];
    downloadCsv(`inventory-${new Date().toISOString().slice(0, 10)}.csv`, [head, ...list.map(line), [], ["TOTAL", "", ...(seeCosts ? [""] : []), total.qty, ...(seeCosts ? [total.amount] : []), ...(showSell ? ["", "", total.min, total.sell] : [])]]);
  }

  return (
    <div className="space-y-3">
      {/* totals first: no scrolling to the bottom */}
      <Card className="border-brand-200 bg-brand-50 p-4">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          {seeCosts ? (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-brand-800">Stock value at cost{filtered ? " (filtered)" : ""}</p>
              <p className="tabular text-3xl font-bold text-brand-800">{fmtMoney(total.amount, cur)}</p>
            </div>
          ) : (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-brand-800">Items in stock{filtered ? " (filtered)" : ""}</p>
              <p className="tabular text-3xl font-bold text-brand-800">{total.qty.toLocaleString("en-US")}</p>
            </div>
          )}
          {showSell && (
            <div className="grid w-full grid-cols-3 gap-x-3 sm:flex sm:w-auto sm:gap-x-6">
              <div>
                <p className="text-[10px] font-medium uppercase tracking-wide text-amber-800 sm:text-xs">At minimum price</p>
                <p className="tabular text-sm font-bold text-amber-800 sm:text-xl">{fmtMoney(total.min, cur)}</p>
              </div>
              <div>
                <p className="text-[10px] font-medium uppercase tracking-wide text-emerald-800 sm:text-xs">At target price</p>
                <p className="tabular text-sm font-bold text-emerald-800 sm:text-xl">{fmtMoney(total.sell, cur)}</p>
              </div>
              {seeCosts && (
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-wide text-slate-600 sm:text-xs">Profit at target</p>
                  <p className="tabular text-sm font-bold text-slate-800 sm:text-xl">{fmtMoney(total.profit, cur)}</p>
                </div>
              )}
            </div>
          )}
        </div>
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm text-brand-800/90">
          {seeCosts && <span><b className="tabular">{total.qty.toLocaleString("en-US")}</b> items</span>}
          <span><b>{list.length}</b> products</span>
          <span><b>{new Set(list.map((r) => r.categories?.name || "")).size}</b> categories</span>
          {total.low > 0 && <button onClick={() => setLowOnly(!lowOnly)} className="font-semibold text-amber-800 underline">{total.low} low / out{lowOnly ? " (showing)" : ""}</button>}
          {seeCosts && total.noCost > 0 && <span className="text-amber-800">{total.noCost} without cost</span>}
          {showSell && total.noPrice > 0 && <span className="font-semibold text-red-700">{total.noPrice} without selling price (not counted)</span>}
        </p>
      </Card>

      <div className="space-y-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <Input className="pl-9" placeholder="Search item, brand, category" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          {categories.length > 1 && (
            <div className="min-w-0 sm:w-52">
              <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
                <option value="all">All categories</option>{categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </div>
          )}
          <div className="min-w-0 sm:w-52">
            <Select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort by">
              <option value="category">By category</option><option value="name">By name (A–Z)</option>
              {seeCosts && <option value="amount">Highest amount first</option>}<option value="quantity">Most in stock first</option>
            </Select>
          </div>
          {sections.length > 1 && (
            <div className="min-w-0 sm:w-52">
              <Select value={section} onChange={(e) => setSection(e.target.value)} aria-label="Section">
                <option value="all">All sections</option>{sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </div>
          )}
          <button onClick={() => setShowSell(!showSell)} aria-pressed={showSell}
            className={cx("h-11 rounded-xl border px-3 text-sm font-medium", showSell ? "border-emerald-600 bg-emerald-50 text-emerald-800" : "border-slate-300 bg-white text-slate-700")}>
            {showSell ? "✓ Min & target prices" : "Show min & target prices"}
          </button>
          {lowOnly && <button onClick={() => setLowOnly(false)} className="h-11 rounded-xl bg-amber-100 px-3 text-sm font-medium text-amber-900">Low stock only ✕</button>}
        </div>
      </div>

      {list.length === 0 ? (
        <Card><EmptyState icon={<Boxes className="size-6" />} title={rows.length ? "Nothing matches" : "No stock yet"} action={!rows.length && biz.canManageAny ? <Link href="/app/products/import?mode=stock"><Button>Import stock</Button></Link> : undefined}>{rows.length ? "Try another search or filter." : "Import your stock list to see it here."}</EmptyState></Card>
      ) : (
        <Card className="overflow-hidden">
          {showSell && <p className="border-b border-slate-100 px-3 py-1.5 text-xs text-slate-500 sm:hidden">Swipe the table left to see Min and Target prices →</p>}
          <div className="max-h-[75vh] overflow-auto">
            <table className="w-full border-collapse text-[13px] sm:text-sm">
              <thead className="sticky top-0 z-10 bg-slate-800 text-left text-xs font-semibold uppercase tracking-wide text-white">
                <tr>
                  <th className="sticky left-0 z-[1] bg-slate-800 px-2 py-2.5 sm:px-3">Item</th>
                  {seeCosts && <th className="px-2 py-2.5 sm:px-3 text-right"><span className="sm:hidden">Cost</span><span className="hidden sm:inline">Cost price</span></th>}
                  <th className="px-2 py-2.5 sm:px-3 text-right">Qty</th>
                  {seeCosts && <th className="px-2 py-2.5 sm:px-3 text-right">Amount</th>}
                  {showSell && <th className="px-2 py-2.5 sm:px-3 text-right text-amber-200">Min price</th>}
                  {showSell && <th className="px-2 py-2.5 sm:px-3 text-right text-emerald-200">Target price</th>}
                  <th className="hidden w-8 px-1 py-2.5 sm:table-cell" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const st = sum(g.rows);
                  return (
                    <Fragment key={g.name || "all"}>
                      {g.name && (
                        <tr className="bg-brand-50">
                          <td colSpan={colCount + 1} className="px-2 py-2 sm:px-3 text-xs font-bold uppercase tracking-wide text-brand-800">{g.name}</td>
                        </tr>
                      )}
                      {g.rows.map((r, i) => {
                        const low = r.stock_qty <= r.low_stock_threshold;
                        return (
                          <tr key={r.id} onClick={() => setMenu(r)} className={cx("cursor-pointer border-t border-slate-100 hover:bg-brand-50", i % 2 === 1 ? "bg-slate-50" : "bg-white")}>
                            <td className={cx("sticky left-0 bg-inherit px-2 py-2 [overflow-wrap:anywhere] sm:px-3", showSell && "min-w-[8.5rem]")}>
                              <span className="font-medium">{r.name}</span>{r.variant_label ? <span className="text-slate-500"> ({r.variant_label})</span> : null}
                              {sort !== "category" && r.categories?.name && <span className="block text-xs text-slate-500">{r.categories.name}</span>}
                            </td>
                            {seeCosts && <td className={cx("tabular whitespace-nowrap px-2 py-2 sm:px-3 text-right", r.cost === null && "text-slate-400")}>{r.cost === null ? "—" : fmtNumber(r.cost)}</td>}
                            <td className="tabular whitespace-nowrap px-2 py-2 sm:px-3 text-right">
                              <span className={cx("font-semibold", r.stock_qty === 0 ? "text-red-600" : low ? "text-amber-700" : "")}>{r.stock_qty}</span>
                              {low && <span className={cx("block text-[10px] leading-none sm:ml-1 sm:inline font-semibold uppercase", r.stock_qty === 0 ? "text-red-600" : "text-amber-700")}>{r.stock_qty === 0 ? "out" : "low"}</span>}
                            </td>
                            {seeCosts && <td className={cx("tabular whitespace-nowrap px-2 py-2 sm:px-3 text-right font-semibold", r.amount === null && "font-normal text-slate-400")}>{r.amount === null ? "—" : fmtNumber(r.amount)}</td>}
                            {showSell && <td className="tabular whitespace-nowrap px-2 py-2 sm:px-3 text-right text-amber-800">{r.min_price === null ? <NotSet /> : fmtNumber(r.min_price)}</td>}
                            {showSell && <td className="tabular whitespace-nowrap px-2 py-2 sm:px-3 text-right font-medium text-emerald-800">{r.target_price === null ? <NotSet /> : fmtNumber(r.target_price)}</td>}
                            <td className="hidden px-1 py-2 text-slate-400 sm:table-cell"><MoreVertical className="size-4" /></td>
                          </tr>
                        );
                      })}
                      {g.name && (
                        <tr className="border-t border-slate-300 bg-slate-100 text-xs font-semibold text-slate-700">
                          <td className="sticky left-0 bg-slate-100 px-2 py-1.5 sm:px-3">Subtotal · {g.rows.length} item{g.rows.length === 1 ? "" : "s"}</td>
                          {seeCosts && <td />}
                          <td className="tabular px-2 py-1.5 sm:px-3 text-right">{st.qty}</td>
                          {seeCosts && <td className="tabular whitespace-nowrap px-2 py-1.5 sm:px-3 text-right">{fmtNumber(st.amount)}</td>}
                          {showSell && <td className="tabular whitespace-nowrap px-2 py-1.5 sm:px-3 text-right text-amber-800">{fmtNumber(st.min)}</td>}
                          {showSell && <td className="tabular whitespace-nowrap px-2 py-1.5 sm:px-3 text-right text-emerald-800">{fmtNumber(st.sell)}</td>}
                          <td className="hidden sm:table-cell" />
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot className="sticky bottom-0 bg-slate-800 text-sm font-bold text-white">
                <tr>
                  <td className="sticky left-0 bg-slate-800 px-2 py-2.5 sm:px-3">TOTAL<span className="hidden sm:inline"> · {list.length} items</span></td>
                  {seeCosts && <td />}
                  <td className="tabular px-2 py-2.5 sm:px-3 text-right">{total.qty.toLocaleString("en-US")}</td>
                  {seeCosts && <td className="tabular whitespace-nowrap px-2 py-2.5 sm:px-3 text-right">{fmtNumber(total.amount)}</td>}
                  {showSell && <td className="tabular whitespace-nowrap px-2 py-2.5 sm:px-3 text-right text-amber-200">{fmtNumber(total.min)}</td>}
                  {showSell && <td className="tabular whitespace-nowrap px-2 py-2.5 sm:px-3 text-right text-emerald-200">{fmtNumber(total.sell)}</td>}
                  <td className="hidden sm:table-cell" />
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span>{seeCosts ? "Amount = cost price × quantity. " : ""}{showSell ? "In subtotal and total rows, Min and Target show the stock value at that price (price × quantity). " : ""}Tap a row to adjust stock, see its history or set prices.</span>
        {list.length > 0 && biz.canReport && <Button variant="ghost" size="sm" onClick={exportCsv}><Download className="size-4" /> Export CSV</Button>}
      </div>

      {menu && (
        <Sheet open onClose={() => setMenu(null)} title={menu.name + (menu.variant_label ? ` (${menu.variant_label})` : "")}>
          <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-slate-500">Category</dt><dd>{menu.categories?.name || "—"}</dd>
            <dt className="text-slate-500">Section</dt><dd>{sections.find((s) => s.id === menu.section_id)?.name}</dd>
            {seeCosts && <><dt className="text-slate-500">Cost price</dt><dd className="tabular">{money(menu.cost)}</dd></>}
            <dt className="text-slate-500">Quantity</dt><dd className="tabular font-semibold">{menu.stock_qty} <span className="font-normal text-slate-500">(alert at {menu.low_stock_threshold})</span></dd>
            {seeCosts && <><dt className="text-slate-500">Amount</dt><dd className="tabular font-semibold">{money(menu.amount)}</dd></>}
            <dt className="text-slate-500">Selling price</dt><dd className="tabular">{menu.target_price === null ? "Not set" : `${fmtMoney(menu.target_price, cur)} (min ${fmtMoney(menu.min_price, cur)})`}</dd>
          </dl>
          <div className="grid gap-2">
            {biz.canManage(menu.section_id) && <Button onClick={() => { onAdjust(menu); setMenu(null); }}><SlidersHorizontal className="size-4" /> Adjust stock</Button>}
            {(biz.canManage(menu.section_id) || biz.canReport) && <Button variant="secondary" onClick={() => { onHistory(menu); setMenu(null); }}><History className="size-4" /> Stock history</Button>}
            {biz.canManage(menu.section_id) && <Link href={`/app/products/edit?id=${menu.id}`}><Button variant="secondary" block>Edit product, prices & photo</Button></Link>}
            {!biz.canManage(menu.section_id) && <Button variant="secondary" onClick={() => { onFlag(menu); setMenu(null); }}><Flag className="size-4" /> Report low stock / arrival</Button>}
          </div>
        </Sheet>
      )}
    </div>
  );
}

function AdjustSheet({ product, onClose, onDone }: { product: Product; onClose: () => void; onDone: () => void }) {
  const biz = useBiz();
  const [kind, setKind] = useState<"adjustment" | "damage" | "return" | "opening">("adjustment");
  const [direction, setDirection] = useState<"add" | "remove">("add");
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const n = parseInt(qty || "0", 10) || 0;
  const change = kind === "damage" ? -n : kind === "adjustment" && direction === "remove" ? -n : n;
  const after = product.stock_qty + change;
  const showCost = change > 0 && biz.canViewCosts(product.section_id) && kind !== "return";

  async function save() {
    setErr(null);
    if (!n) return setErr("Enter a quantity.");
    if (after < 0) return setErr("Stock can't go below zero.");
    if (!reason.trim() && kind !== "opening") return setErr("Give a reason. It's kept in the stock history.");
    setBusy(true);
    const { error } = await supabase().rpc("adjust_stock", { p_product: product.id, p_qty_change: change, p_kind: kind, p_reason: reason || null, p_unit_cost: showCost && cost ? minorToDecimal(toMinor(cost)) : null });
    setBusy(false);
    if (error) setErr(errorMessage(error)); else onDone();
  }

  return (
    <Sheet open onClose={onClose} title={`Adjust: ${product.name}`} footer={<Button block size="lg" loading={busy} onClick={save}>Save adjustment</Button>}>
      <div className="space-y-3">
        <Field label="Type">
          <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="adjustment">Count correction</option>
            <option value="damage">Damage / loss / theft</option>
            <option value="return">Customer return (back to stock)</option>
            <option value="opening">Opening stock</option>
          </Select>
        </Field>
        {kind === "adjustment" && (
          <div className="grid grid-cols-2 gap-2">
            {(["add", "remove"] as const).map((d) => (
              <button key={d} onClick={() => setDirection(d)} className={cx("rounded-xl border p-2.5 text-sm font-semibold", direction === d ? "border-brand bg-brand-50 text-brand-700" : "border-slate-300")}>{d === "add" ? "Add to stock" : "Remove from stock"}</button>
            ))}
          </div>
        )}
        <Field label="Quantity"><Input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} /></Field>
        {showCost && <Field label="Unit cost (optional)" hint="Updates the weighted average cost"><MoneyInput value={cost} onChange={setCost} /></Field>}
        <Field label="Reason"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Physical count on Saturday" /></Field>
        <div className="rounded-xl bg-slate-50 p-3 text-sm">Stock: <b>{product.stock_qty}</b> → <b className={after < 0 ? "text-red-600" : ""}>{after}</b></div>
        {err && <Alert tone="danger">{err}</Alert>}
      </div>
    </Sheet>
  );
}

function HistorySheet({ product, onClose }: { product: Product; onClose: () => void }) {
  const { business } = useBiz();
  const [rows, setRows] = useState<Movement[] | null>(null);
  useEffect(() => {
    supabase().from("stock_movements").select("*, profiles(full_name)").eq("product_id", product.id).order("created_at", { ascending: false }).limit(100)
      .then(({ data }) => setRows((data || []) as Movement[]));
  }, [product.id]);
  return (
    <Sheet open onClose={onClose} title={`History: ${product.name}`} wide>
      {rows === null ? <Spinner /> : rows.length === 0 ? <p className="py-6 text-center text-sm text-slate-500">No stock movements yet.</p> : (
        <ul className="divide-y divide-slate-100">
          {rows.map((m) => <MovementRow key={m.id} m={m} tz={business.timezone} />)}
        </ul>
      )}
    </Sheet>
  );
}

function MovementRow({ m, tz, showProduct }: { m: Movement; tz: string; showProduct?: boolean }) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{showProduct && m.products ? `${m.products.name}${m.products.variant_label ? ` (${m.products.variant_label})` : ""} · ` : ""}{KIND_LABEL[m.kind] || m.kind}</p>
        <p className="truncate text-xs text-slate-500">
          {fmtDateTime(m.created_at, tz)} · {m.profiles?.full_name || "—"}{m.reason ? ` · ${m.reason}` : ""}
          {m.ref_type === "sale" && m.ref_id ? <> · <Link className="text-brand underline" href={`/app/sales/view?id=${m.ref_id}`}>receipt</Link></> : null}
        </p>
      </div>
      <span className={cx("tabular w-14 text-right font-semibold", m.qty_change > 0 ? "text-emerald-700" : "text-red-700")}>{m.qty_change > 0 ? "+" : ""}{m.qty_change}</span>
      <span className="tabular w-12 text-right text-sm text-slate-500">= {m.balance_after}</span>
    </li>
  );
}

function Movements() {
  const { business } = useBiz();
  const [rows, setRows] = useState<Movement[] | null>(null);
  const [kind, setKind] = useState("all");
  useEffect(() => {
    let q = supabase().from("stock_movements").select("*, profiles(full_name), products(name, variant_label)").eq("business_id", business.id).order("created_at", { ascending: false }).limit(200);
    if (kind !== "all") q = q.eq("kind", kind);
    q.then(({ data }) => setRows((data || []) as Movement[]));
  }, [business.id, kind]);
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm text-slate-500">Every change in quantity is recorded here and can&apos;t be edited.</p>
        <Select className="w-48" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Movement type">
          <option value="all">All types</option>{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </div>
      {rows === null ? <Spinner /> : rows.length === 0 ? <p className="py-6 text-center text-sm text-slate-500">No movements.</p> : (
        <ul className="divide-y divide-slate-100">{rows.map((m) => <MovementRow key={m.id} m={m} tz={business.timezone} showProduct />)}</ul>
      )}
    </Card>
  );
}

function Purchases({ cur }: { cur: string }) {
  const { business, sections } = useBiz();
  const [rows, setRows] = useState<Purchase[] | null>(null);
  useEffect(() => {
    supabase().from("purchases").select("*, suppliers(name), purchase_lines(quantity, unit_price, landed_unit_cost, allocated_extra, products(name))")
      .eq("business_id", business.id).order("created_at", { ascending: false }).limit(100).then(({ data }) => setRows((data || []) as Purchase[]));
  }, [business.id]);
  if (rows === null) return <Spinner />;
  if (!rows.length) return <EmptyState icon={<Truck className="size-6" />} title="No purchases recorded" action={<Link href="/app/inventory/receive"><Button>Receive stock</Button></Link>}>Record purchases to keep batch costs and compare China vs local suppliers.</EmptyState>;
  return (
    <div className="space-y-3">
      {rows.map((p) => (
        <Card key={p.id} className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-semibold">{p.suppliers?.name || "Unknown supplier"} <Badge tone={p.source === "import" ? "brand" : "neutral"}>{p.source === "import" ? "Imported" : "Local"}</Badge></p>
              <p className="text-xs text-slate-500">{fmtDate(p.purchase_date)} · {sections.find((s) => s.id === p.section_id)?.name}{p.reference ? ` · ref ${p.reference}` : ""}{p.currency !== business.currency ? ` · ${p.currency} @ ${p.exchange_rate}` : ""}</p>
            </div>
            <p className="text-right text-xs text-slate-500">Freight {fmtMoney(p.freight_cost, cur)} · Other {fmtMoney(p.other_costs, cur)}<br />Allocated by {p.allocation_method}</p>
          </div>
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-xs text-slate-500"><tr><th className="py-1">Item</th><th className="text-right">Qty</th><th className="text-right">Unit price</th><th className="text-right">+ Extra</th><th className="text-right">Landed / unit</th></tr></thead>
            <tbody>
              {(p.purchase_lines || []).map((l, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="py-1.5">{l.products?.name}</td>
                  <td className="tabular text-right">{l.quantity}</td>
                  <td className="tabular text-right">{l.unit_price} {p.currency === business.currency ? "" : p.currency}</td>
                  <td className="tabular text-right">{fmtMoney(l.allocated_extra, cur)}</td>
                  <td className="tabular text-right font-semibold">{fmtMoney(l.landed_unit_cost, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  );
}

function Flags() {
  const { business } = useBiz();
  const toast = useToast();
  const [rows, setRows] = useState<StockFlag[] | null>(null);
  const load = useCallback(() => {
    supabase().from("stock_flags").select("*, products(name), profiles!stock_flags_created_by_fkey(full_name)").eq("business_id", business.id).is("resolved_at", null).order("created_at", { ascending: false })
      .then(({ data }) => setRows((data || []) as StockFlag[]));
  }, [business.id]);
  useEffect(load, [load]);
  if (rows === null) return <Spinner />;
  if (!rows.length) return <EmptyState icon={<Flag className="size-6" />} title="No open reports">Staff can report low stock or that new stock has arrived from the Inventory screen.</EmptyState>;
  return (
    <Card>
      <ul className="divide-y divide-slate-100">
        {rows.map((f) => (
          <li key={f.id} className="flex items-center gap-3 px-4 py-3">
            <Badge tone={f.kind === "low" ? "warning" : "info"}>{f.kind === "low" ? "Low stock" : "Arrived"}</Badge>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{f.products?.name}</p>
              <p className="truncate text-xs text-slate-500">{f.profiles?.full_name} · {fmtDateTime(f.created_at, business.timezone)}{f.note ? ` · ${f.note}` : ""}</p>
            </div>
            <Button size="sm" variant="secondary" onClick={async () => { const { error } = await supabase().rpc("resolve_stock_flag", { p_flag: f.id }); if (error) toast(errorMessage(error), "error"); else load(); }}><Check className="size-4" /> Done</Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function InventoryPage() {
  return <Suspense><InventoryInner /></Suspense>;
}
