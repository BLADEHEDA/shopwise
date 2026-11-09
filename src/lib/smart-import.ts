"use client";
// Browser side of importing any kind of stock file:
//  - Word (.docx): tables are read directly; otherwise the text goes to smart reading
//  - photos / scans / messy files: sent to /api/smart-import (Claude)
import { supabase } from "./supabase";
import { shrinkImage } from "@/components/product-photo";
import type { Cell, Parsed } from "./sheet-parse";
import type { SmartResult } from "./smart-import-types";

export type Kind = "xlsx" | "csv" | "pdf" | "docx" | "image" | "unknown";
export function fileKind(f: File): Kind {
  const n = f.name.toLowerCase();
  if (n.endsWith(".xlsx")) return "xlsx";
  if (n.endsWith(".csv") || n.endsWith(".txt")) return "csv";
  if (n.endsWith(".pdf") || f.type === "application/pdf") return "pdf";
  if (n.endsWith(".docx")) return "docx";
  if (f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/.test(n)) return "image";
  return "unknown";
}

/** Word: tables become rows (each paragraph outside a table becomes a one-cell row, e.g. a category heading). */
export async function readDocx(file: File): Promise<{ rows: Cell[][]; tables: number; text: string }> {
  // @ts-expect-error: mammoth's browser build ships without types
  const mammoth = (await import("mammoth/mammoth.browser")).default ?? (await import("mammoth/mammoth.browser"));
  const buf = await file.arrayBuffer();
  const [{ value: html }, { value: text }] = await Promise.all([mammoth.convertToHtml({ arrayBuffer: buf }), mammoth.extractRawText({ arrayBuffer: buf })]);
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const rows: Cell[][] = [];
  let tables = 0;
  for (const el of Array.from(doc.body.firstElementChild?.children || [])) {
    if (el.tagName === "TABLE") {
      tables++;
      for (const tr of Array.from(el.querySelectorAll("tr"))) rows.push(Array.from(tr.querySelectorAll("td,th")).map((c) => (c.textContent || "").trim()));
    } else {
      const t = (el.textContent || "").trim();
      if (t) rows.push([t]);
    }
  }
  return { rows, tables, text };
}

const toBase64 = (b: Blob) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(",")[1] || "");
  r.onerror = () => rej(r.error);
  r.readAsDataURL(b);
});

/** Send photos / a PDF / extracted text to the server for AI reading. */
export async function smartRead(businessId: string, input: { files?: File[]; text?: string; fileName: string }): Promise<SmartResult> {
  const files: { name: string; media_type: string; data: string }[] = [];
  for (const f of input.files || []) {
    if (fileKind(f) === "image") {
      const jpg = await shrinkImage(f, 2000); // readable but small
      files.push({ name: f.name, media_type: "image/jpeg", data: await toBase64(jpg) });
    } else if (fileKind(f) === "pdf") {
      if (f.size > 3_800_000) throw new Error("This PDF is too big for smart reading (max about 4 MB). Split it, or upload the Excel file.");
      files.push({ name: f.name, media_type: "application/pdf", data: await toBase64(f) });
    }
  }
  const { data: s } = await supabase().auth.getSession();
  const res = await fetch("/api/smart-import", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${s.session?.access_token || ""}` },
    body: JSON.stringify({ business_id: businessId, files, text: input.text, file_name: input.fileName }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `Smart reading failed (${res.status})`);
  return out as SmartResult;
}

/** AI result → the same structure the preview uses for spreadsheets. */
export function smartToParsed(r: SmartResult, sheet: string): Parsed {
  const header = ["Item", "Category", "Variant", "Brand", "Cost Price", "Quantity", "Target price", "Min price"];
  const cats = new Set<string>();
  const rows = r.products.map((p, i) => {
    let cost = p.cost_price;
    if ((cost === null || cost === undefined) && p.line_total && p.quantity) cost = Math.round((p.line_total / p.quantity) * 100) / 100;
    if (p.category) cats.add(p.category);
    const notes: string[] = [];
    if (p.uncertain) notes.push(`Check: ${p.uncertain}`);
    if (p.line_total && cost && p.quantity && Math.abs(cost * p.quantity - p.line_total) > 1) notes.push(`Line total on the list is ${p.line_total}, but cost × quantity = ${cost * p.quantity}`);
    const v = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));
    return {
      sheet, line: i + 1, category: p.category || "",
      cells: [p.name, p.category || "", p.variant || "", p.brand || "", v(cost), v(p.quantity), v(p.selling_price), v(p.min_price)],
      note: notes.join(" · ") || undefined,
    };
  });
  return { header, rows, headerLine: 1, categories: Array.from(cats), skipped: r.skipped.length ? [{ heading: r.skipped.slice(0, 3).join("; ") + (r.skipped.length > 3 ? "…" : ""), rows: r.skipped.length }] : [] };
}
