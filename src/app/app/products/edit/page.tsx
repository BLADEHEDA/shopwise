"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ImagePlus } from "lucide-react";
import { useBiz } from "@/components/biz";
import { useToast } from "@/components/toast";
import { Alert, Button, Card, Field, Input, MoneyInput, PageHeader, Select, Spinner, Textarea } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { minorToDecimal, toMinor, fmtMoney } from "@/lib/money";
import { shrinkImage, ProductThumb } from "@/components/product-photo";
import { errorMessage, uuid } from "@/lib/format";
import type { Product } from "@/lib/types";

interface Form {
  section_id: string; category: string; name: string; brand: string; model: string; sku: string; barcode: string;
  parent_id: string; variant_label: string; description: string; specs: string; image_url: string;
  target_price: string; min_price: string; low_stock_threshold: string; active: boolean;
  cost: string; opening_stock: string;
}

function EditInner() {
  const id = useSearchParams().get("id");
  const router = useRouter();
  const toast = useToast();
  const biz = useBiz();
  const { business } = biz;
  const editableSections = biz.sections.filter((s) => s.active && biz.canManage(s.id));
  const [f, setF] = useState<Form | null>(null);
  const [orig, setOrig] = useState<Product | null>(null);
  const [cats, setCats] = useState<{ id: string; name: string }[]>([]);
  const [parents, setParents] = useState<Product[]>([]);
  const [origCost, setOrigCost] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    const sb = supabase();
    sb.from("categories").select("id, name").eq("business_id", business.id).order("name").then(({ data }) => setCats(data || []));
    sb.from("products").select("*").eq("business_id", business.id).is("parent_id", null).order("name").then(({ data }) => setParents((data || []) as Product[]));
    if (!id) {
      setF({ section_id: editableSections[0]?.id || "", category: "", name: "", brand: "", model: "", sku: "", barcode: "", parent_id: "", variant_label: "",
        description: "", specs: "", image_url: "", target_price: "", min_price: "", low_stock_threshold: "3", active: true, cost: "", opening_stock: "" });
      return;
    }
    (async () => {
      const { data } = await sb.from("products").select("*, categories(name)").eq("id", id).maybeSingle();
      if (!data) { setErr("Product not found"); return; }
      const p = data as Product;
      setOrig(p);
      const c = await sb.from("product_costs").select("avg_cost").eq("product_id", id).maybeSingle();
      if (c.data) setOrigCost((c.data as { avg_cost: number }).avg_cost);
      setF({
        section_id: p.section_id, category: p.categories?.name || "", name: p.name, brand: p.brand || "", model: p.model || "", sku: p.sku || "",
        barcode: p.barcode || "", parent_id: p.parent_id || "", variant_label: p.variant_label || "", description: p.description || "",
        specs: Object.entries(p.specs || {}).map(([k, v]) => `${k}: ${v}`).join("\n"), image_url: p.image_url || "",
        target_price: p.target_price === null ? "" : String(p.target_price), min_price: p.min_price === null ? "" : String(p.min_price), low_stock_threshold: String(p.low_stock_threshold), active: p.active,
        cost: c.data ? String((c.data as { avg_cost: number }).avg_cost) : "", opening_stock: "",
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, business.id]);

  if (err && !f) return <Alert tone="danger">{err}</Alert>;
  if (!f) return <Spinner />;
  const set = (patch: Partial<Form>) => setF({ ...f, ...patch });
  const canCost = biz.canViewCosts(f.section_id);
  const hasPrice = f.target_price.trim() !== "";
  const target = toMinor(f.target_price), min = toMinor(f.min_price || f.target_price);

  async function upload(file: File) {
    setUploading(true);
    const blob = await shrinkImage(file);
    const path = `${business.id}/products/${uuid()}.jpg`;
    const { error } = await supabase().storage.from("shopwise").upload(path, blob, { upsert: false, contentType: "image/jpeg" });
    setUploading(false);
    if (error) { toast(errorMessage(error), "error"); return; }
    set({ image_url: supabase().storage.from("shopwise").getPublicUrl(path).data.publicUrl });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!f) return;
    setErr(null);
    if (!f.name.trim()) return setErr("Name is required.");
    if (!hasPrice && f.min_price.trim()) return setErr("Enter the target selling price too, or clear the minimum price.");
    if (hasPrice && !(target > 0)) return setErr("The target selling price must be more than 0.");
    if (hasPrice && (!(min > 0) || min > target)) return setErr("Minimum price must be more than 0 and not above the target price.");
    setBusy(true);
    const sb = supabase();
    try {
      let category_id: string | null = null;
      if (f.category.trim()) {
        const ex = cats.find((c) => c.name.toLowerCase() === f.category.trim().toLowerCase());
        if (ex) category_id = ex.id;
        else {
          const { data, error } = await sb.from("categories").insert({ business_id: business.id, name: f.category.trim() }).select("id").single();
          if (error) throw error;
          category_id = (data as { id: string }).id;
        }
      }
      const specs: Record<string, string> = {};
      for (const line of f.specs.split("\n")) {
        const i = line.indexOf(":");
        if (i > 0) specs[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      const row = {
        section_id: f.section_id, category_id, name: f.name.trim(), brand: f.brand.trim() || null, model: f.model.trim() || null,
        sku: f.sku.trim() || null, barcode: f.barcode.trim() || null, parent_id: f.parent_id || null, variant_label: f.variant_label.trim() || null,
        description: f.description.trim() || null, specs, image_url: f.image_url || null,
        target_price: hasPrice ? minorToDecimal(target) : null, min_price: hasPrice ? minorToDecimal(min) : null, low_stock_threshold: parseInt(f.low_stock_threshold || "0", 10) || 0, active: f.active,
      };
      let pid = id;
      if (id) {
        const { error } = await sb.from("products").update(row).eq("id", id);
        if (error) throw error;
      } else {
        const { data, error } = await sb.from("products").insert({ ...row, business_id: business.id }).select("id").single();
        if (error) throw error;
        pid = (data as { id: string }).id;
      }
      const cost = f.cost.trim() ? minorToDecimal(toMinor(f.cost)) : null;
      const opening = parseInt(f.opening_stock || "0", 10) || 0;
      if (!id && opening > 0) {
        const { error } = await sb.rpc("adjust_stock", { p_product: pid, p_qty_change: opening, p_kind: "opening", p_reason: "opening stock", p_unit_cost: canCost ? cost : null });
        if (error) throw error;
      } else if (canCost && cost !== null && toMinor(cost) !== toMinor(origCost ?? -1)) {
        const { error } = await sb.rpc("set_product_cost", { p_product: pid, p_cost: cost });
        if (error) throw error;
      }
      toast(id ? "Product updated" : "Product added");
      router.push("/app/products");
    } catch (e) {
      const m = errorMessage(e);
      setErr(/products_sku_uq|duplicate key/.test(m) ? "Another product already uses this SKU." : m);
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={save} className="mx-auto max-w-2xl space-y-4">
      <button type="button" onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm font-medium text-slate-600"><ChevronLeft className="size-4" /> Products</button>
      <PageHeader title={id ? "Edit product" : "Add product"} />
      {orig && !biz.canManage(orig.section_id) && <Alert tone="warning">You can view but not edit products in this section.</Alert>}

      <Card className="space-y-4 p-4">
        <div className="flex gap-4">
          <label className="relative grid size-24 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 text-slate-500 hover:border-brand">
            {f.image_url
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={f.image_url} alt="" className="size-full object-cover" />
              : <span className="relative size-full"><ProductThumb product={{ name: f.name || "?", image_url: null, categories: { name: f.category } }} /><span className="absolute inset-x-0 bottom-1 flex items-center justify-center gap-1 text-[11px] font-semibold text-brand-700"><ImagePlus className="size-3.5" />{uploading ? "Uploading…" : "Add photo"}</span></span>}
            <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          </label>
          <div className="flex-1 space-y-3">
            <Field label="Product name"><Input required value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Wireless Headset" /></Field>
            <Field label="Section">
              <Select value={f.section_id} onChange={(e) => set({ section_id: e.target.value })}>
                {editableSections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Category">
            <Input list="cats" value={f.category} onChange={(e) => set({ category: e.target.value })} placeholder="e.g. Audio" />
            <datalist id="cats">{cats.map((c) => <option key={c.id} value={c.name} />)}</datalist>
          </Field>
          <Field label="Brand"><Input value={f.brand} onChange={(e) => set({ brand: e.target.value })} /></Field>
          <Field label="Model"><Input value={f.model} onChange={(e) => set({ model: e.target.value })} /></Field>
          <Field label="SKU"><Input value={f.sku} onChange={(e) => set({ sku: e.target.value })} /></Field>
          <Field label="Barcode"><Input inputMode="numeric" value={f.barcode} onChange={(e) => set({ barcode: e.target.value })} /></Field>
          <Field label="Low-stock alert at" hint="Alert when stock falls to this"><Input inputMode="numeric" value={f.low_stock_threshold} onChange={(e) => set({ low_stock_threshold: e.target.value.replace(/\D/g, "") })} /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Variant of (optional)" hint="Group sizes/models under one product">
            <Select value={f.parent_id} onChange={(e) => set({ parent_id: e.target.value })}>
              <option value="">— Not a variant —</option>
              {parents.filter((p) => p.id !== id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="Variant label" hint="e.g. 3×3, Black, 64GB"><Input value={f.variant_label} onChange={(e) => set({ variant_label: e.target.value })} /></Field>
        </div>
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="font-semibold">Prices</h2>
        {!hasPrice && <Alert tone="warning">No selling price yet: this product won&apos;t appear at the POS until you set one.</Alert>}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Target selling price" hint="Staff start here"><MoneyInput value={f.target_price} onChange={(v) => set({ target_price: v })} placeholder="Not set" /></Field>
          <Field label="Minimum price" hint="Lowest staff can go without approval"><MoneyInput value={f.min_price} onChange={(v) => set({ min_price: v })} placeholder={f.target_price} /></Field>
          {canCost && <Field label="Cost price (owner only)" hint={origCost !== null ? `Current avg. landed cost ${fmtMoney(origCost, business.currency)}` : "Never shown to staff"}><MoneyInput value={f.cost} onChange={(v) => set({ cost: v })} /></Field>}
        </div>
        {canCost && toMinor(f.cost) > 0 && target > 0 && (
          <p className="text-sm text-slate-600">Margin at target: <b>{Math.round(((target - toMinor(f.cost)) / target) * 100)}%</b> · at minimum: <b>{Math.round(((min - toMinor(f.cost)) / min) * 100)}%</b></p>
        )}
        {!id && (
          <Field label="Opening stock" hint="How many you have right now. Later changes go through Inventory.">
            <Input inputMode="numeric" value={f.opening_stock} onChange={(e) => set({ opening_stock: e.target.value.replace(/\D/g, "") })} />
          </Field>
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <Field label="Description"><Textarea rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} /></Field>
        <Field label="Specifications" hint="One per line, e.g. Battery: 20 hours"><Textarea rows={3} value={f.specs} onChange={(e) => set({ specs: e.target.value })} /></Field>
        <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" className="size-4 accent-brand" checked={f.active} onChange={(e) => set({ active: e.target.checked })} /> Active (shown at the POS)</label>
      </Card>

      {err && <Alert tone="danger">{err}</Alert>}
      <Button type="submit" size="lg" block loading={busy} disabled={!editableSections.length}>{id ? "Save changes" : "Add product"}</Button>
    </form>
  );
}

export default function EditProduct() {
  return <Suspense><EditInner /></Suspense>;
}
