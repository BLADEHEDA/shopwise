// Smart reading: turns photos of handwritten lists, scanned PDFs, Word files
// and messy sheets into product rows, using Claude (vision + PDF support).
// The browser shows the result in the import preview; nothing is saved here.
//
// Needs ANTHROPIC_API_KEY (Vercel → Settings → Environment Variables).
// Each call is checked against the user's role and a daily limit per business
// (begin_ai_import in migration 0006).
import { createClient } from "@supabase/supabase-js";
import type { SmartProduct } from "@/lib/smart-import-types";

export const runtime = "nodejs";
export const maxDuration = 300;

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const API = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
const MAX_BYTES = 4_000_000; // Vercel request body limit is ~4.5 MB

interface InFile { name: string; media_type: string; data: string }
interface Body { business_id: string; files?: InFile[]; text?: string; file_name?: string }



const TOOL = {
  name: "record_inventory",
  description: "Record every product line found in the shop's document.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["products", "skipped", "currency", "notes"],
    properties: {
      products: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "category", "variant", "brand", "cost_price", "quantity", "line_total", "selling_price", "min_price", "uncertain"],
          properties: {
            name: { type: "string", description: "Product name as written (keep the shop's words; fix only obvious reading errors)." },
            category: { type: ["string", "null"], description: "The heading the product is listed under; if there is none, a short sensible group name (e.g. 'Phone Chargers', 'Drinks')." },
            variant: { type: ["string", "null"], description: "Size/colour/capacity if written separately from the name, else null." },
            brand: { type: ["string", "null"] },
            cost_price: { type: ["number", "null"], description: "Unit cost (buying price) for ONE item, plain number without currency." },
            quantity: { type: ["integer", "null"], description: "Quantity in stock." },
            line_total: { type: ["number", "null"], description: "Total written on the line (e.g. Amount = cost x quantity), if any." },
            selling_price: { type: ["number", "null"], description: "Selling / retail price for one item, only if written." },
            min_price: { type: ["number", "null"], description: "Lowest/minimum selling price, only if written." },
            uncertain: { type: ["string", "null"], description: "If any value on this line was hard to read or guessed, say which in a few words; else null." },
          },
        },
      },
      skipped: { type: "array", items: { type: "string" }, description: "Lines that are NOT products: totals, sub-totals, titles, shop expenses (rent, salaries, electricity, transport)..." },
      currency: { type: ["string", "null"], description: "Currency used, e.g. XAF/FCFA, NGN, USD; null if not shown." },
      notes: { type: ["string", "null"], description: "Anything the shop owner should check, in one or two short sentences." },
    },
  },
};

const INSTRUCTIONS = `You are reading a shop's stock list so it can be imported into a point-of-sale app.
The list may be a printed table, an Excel export, a Word document, or a phone photo of handwritten notes, in English or French.

Rules:
- Output one product per distinct product line, in the order they appear. Never invent products.
- Use the heading a product sits under as its category. Without headings, choose short, consistent group names.
- Keep names as written, but when a name only makes sense together with its heading (e.g. "2GB" under USB KEY, "P9" under BLUETOOTH HEADSET, "LG" under TV REMOTE), write the full name: "USB Key 2GB", "Bluetooth Headset P9", "TV Remote LG".
- cost_price is the price for ONE unit. If only a line total and a quantity are written, cost_price = total / quantity.
- If columns are not labelled, use common sense: usually name, then unit cost, then quantity, then total. A column where value x other column = third column tells you which is which.
- Read numbers carefully: "1.500" or "1 500" in French means 1500; "2k" means 2000; "5,000F"/"5000frs"/"FCFA" are currency marks.
- Leave a value null when it is not written. Do not guess selling prices.
- Do not include totals, sub-totals, titles, dates or shop expenses (rent, salaries, light bill, transport) as products: list them in "skipped".
- If handwriting is unclear, give your best reading and explain in "uncertain".
Call the record_inventory tool exactly once with the complete result.`;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return json(501, { error: "Smart reading is not switched on yet. The platform administrator needs to add an ANTHROPIC_API_KEY in Vercel." });
  }
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json(401, { error: "Please sign in again." });
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_BYTES * 1.4) return json(413, { error: "This file is too big for smart reading (max about 4 MB). Split it into smaller files or photos." });

  let body: Body;
  try { body = (await req.json()) as Body; } catch { return json(400, { error: "Invalid request" }); }
  if (!body.business_id || (!body.files?.length && !body.text)) return json(400, { error: "Nothing to read" });
  if ((body.files?.length || 0) > 20) return json(400, { error: "Send at most 20 photos/pages at a time." });

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const fileName = body.file_name || body.files?.map((f) => f.name).join(", ") || "text";
  const begin = await sb.rpc("begin_ai_import", { p_business: body.business_id, p_file: fileName, p_pages: body.files?.length ?? null });
  if (begin.error) return json(403, { error: begin.error.message });
  const usageId = begin.data as string;

  const content: unknown[] = [];
  for (const f of body.files || []) {
    if (f.media_type === "application/pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } });
    else if (/^image\/(jpeg|png|gif|webp)$/.test(f.media_type)) content.push({ type: "image", source: { type: "base64", media_type: f.media_type, data: f.data } });
  }
  if (body.text) content.push({ type: "text", text: `Document "${fileName}":\n\n${body.text.slice(0, 400_000)}` });
  content.push({ type: "text", text: "Read this stock list and record it with the record_inventory tool." });

  try {
    const res = await fetch(`${API}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 32000,
        system: INSTRUCTIONS,
        tools: [TOOL],
        tool_choice: { type: "auto" },
        output_config: { effort: "medium" },
        messages: [{ role: "user", content }],
      }),
    });
    const out = await res.json();
    if (!res.ok) {
      const msg = out?.error?.message || `AI service error ${res.status}`;
      await sb.rpc("finish_ai_import", { p_id: usageId, p_ok: false, p_input: 0, p_output: 0, p_products: 0, p_error: msg });
      return json(502, { error: res.status === 529 || res.status === 503 ? "The AI service is busy. Please try again in a minute." : `Smart reading failed: ${msg}` });
    }
    const blocks = (out.content || []) as { type: string; name?: string; input?: unknown; text?: string }[];
    let result = blocks.find((b) => b.type === "tool_use" && b.name === TOOL.name)?.input as
      { products: SmartProduct[]; skipped: string[]; currency: string | null; notes: string | null } | undefined;
    if (!result) {
      // fallback: JSON in a text block
      const txt = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const m = txt.match(/\{[\s\S]*\}/);
      if (m) try { result = JSON.parse(m[0]); } catch {}
    }
    const products = (result?.products || []).filter((p) => p && typeof p.name === "string" && p.name.trim());
    await sb.rpc("finish_ai_import", {
      p_id: usageId, p_ok: products.length > 0, p_input: out.usage?.input_tokens ?? 0, p_output: out.usage?.output_tokens ?? 0,
      p_products: products.length, p_error: products.length ? null : "no products found",
    });
    if (!products.length) return json(422, { error: "No products could be read from this file. Try a clearer photo (good light, whole page, flat) or an Excel file." });
    return json(200, {
      products, skipped: result?.skipped || [], currency: result?.currency || null, notes: result?.notes || null,
      truncated: out.stop_reason === "max_tokens",
    });
  } catch (e) {
    await sb.rpc("finish_ai_import", { p_id: usageId, p_ok: false, p_input: 0, p_output: 0, p_products: 0, p_error: String(e) });
    return json(502, { error: "Couldn't reach the AI service. Check your connection and try again." });
  }
}
