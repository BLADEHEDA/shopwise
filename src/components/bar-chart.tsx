"use client";
import { useState } from "react";

/** Single-series bar chart (no legend needed — the card title names it).
 *  Thin bars with 4px rounded data-ends on a recessive grid, a hover
 *  tooltip on a hit target wider than the bar, and a table toggle. */
export function BarChart({ data, format, label }: { data: { x: string; y: number; sub?: string }[]; format: (v: number) => string; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = Math.max(1, ...data.map((d) => d.y));
  const ticks = [0, 0.5, 1].map((t) => max * t);

  if (!data.length) return <p className="py-10 text-center text-sm text-slate-500">No sales in this period.</p>;

  return (
    <div>
      <div className="mb-2 flex justify-end">
        <button onClick={() => setTable(!table)} className="text-xs font-medium text-brand hover:underline">{table ? "Show chart" : "Show table"}</button>
      </div>
      {table ? (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500"><tr><th className="py-1">Date</th><th className="text-right">{label}</th></tr></thead>
          <tbody>{data.map((d) => <tr key={d.x} className="border-t border-slate-100"><td className="py-1.5">{d.x}</td><td className="tabular text-right">{format(d.y)}</td></tr>)}</tbody>
        </table>
      ) : (
        <div className="relative" role="img" aria-label={`${label} by day`}>
          <div className="relative h-48">
            {ticks.map((t, i) => (
              <div key={i} className="absolute inset-x-0 border-t border-slate-100" style={{ bottom: `${(t / max) * 100}%` }}>
                <span className="tabular absolute -top-2.5 left-0 bg-white pr-1 text-[10px] text-slate-400">{i === 0 ? "" : format(t)}</span>
              </div>
            ))}
            <div className="absolute inset-0 flex items-end gap-[2px] pl-14">
              {data.map((d, i) => (
                <div key={d.x} className="relative flex h-full flex-1 items-end justify-center" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                  onTouchStart={() => setHover(i)}>
                  <div className="w-full max-w-6 rounded-t-[4px] bg-brand transition-opacity" style={{ height: `${Math.max(1, (d.y / max) * 100)}%`, opacity: hover === null || hover === i ? 1 : 0.45 }} />
                  {hover === i && (
                    <div className="pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs text-white shadow-lg">
                      <p className="font-semibold">{d.x}</p>
                      <p className="tabular">{format(d.y)}</p>
                      {d.sub && <p className="text-slate-300">{d.sub}</p>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="mt-1 flex gap-[2px] pl-14 text-[10px] text-slate-500">
            {data.map((d, i) => (
              <span key={d.x} className="flex-1 truncate text-center">{data.length <= 10 || i % Math.ceil(data.length / 8) === 0 ? d.x.slice(5) : ""}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
