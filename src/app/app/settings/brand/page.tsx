"use client";
import { useState } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { useBiz } from "@/components/biz";
import { useToast } from "@/components/toast";
import { Alert, Button, Card, Field, Input, PageHeader } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { BrandMark, useBrand } from "@/lib/brand";
import { errorMessage, uuid } from "@/lib/format";

const PRESETS = ["Shopwise", "Vendora", "StorePilot"];

function isTeal(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.15) return false; // greyish
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return h >= 160 && h <= 200;
}

export default function BrandPage() {
  const biz = useBiz();
  const { brand, reload } = useBrand();
  const toast = useToast();
  const [f, setF] = useState({ ...brand, logo_url: brand.logo_url || "", icon_url: brand.icon_url || "", support_email: brand.support_email || "", support_phone: brand.support_phone || "" });
  const [busy, setBusy] = useState(false);

  if (!biz.isPlatformAdmin) return <Alert tone="warning">Only a platform administrator can change the product branding.</Alert>;

  async function upload(file: File, key: "logo_url" | "icon_url") {
    const path = `${biz.business.id}/brand-${uuid()}.${(file.name.split(".").pop() || "png").toLowerCase()}`;
    const { error } = await supabase().storage.from("shopwise").upload(path, file, { contentType: file.type });
    if (error) { toast(errorMessage(error), "error"); return; }
    setF({ ...f, [key]: supabase().storage.from("shopwise").getPublicUrl(path).data.publicUrl });
  }

  async function save() {
    if (!/^#[0-9a-f]{6}$/i.test(f.primary_color)) { toast("Colour must be a hex value like #3158C9", "error"); return; }
    if (isTeal(f.primary_color) && !confirm("This colour looks teal/turquoise, which the brand brief avoids. Save anyway?")) return;
    setBusy(true);
    const { error } = await supabase().rpc("update_brand", {
      p_product_name: f.product_name, p_tagline: f.tagline, p_logo_url: f.logo_url, p_icon_url: f.icon_url, p_primary_color: f.primary_color,
      p_support_email: f.support_email, p_support_phone: f.support_phone,
    });
    setBusy(false);
    if (error) { toast(errorMessage(error), "error"); return; }
    reload();
    toast(`Brand saved: ${f.product_name}. Installed apps update their name within a few minutes.`);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link href="/app/settings" className="inline-flex items-center gap-1 text-sm font-medium text-slate-600"><ChevronLeft className="size-4" /> Settings</Link>
      <PageHeader title="Product branding" subtitle="Changes the product name, logo and colour everywhere: login, navigation, receipts and the installed app. Business data is never touched." />
      <Card className="flex items-center justify-between p-4"><span className="text-sm text-slate-500">Current</span><BrandMark size={32} /></Card>
      <Card className="space-y-3 p-4">
        <Field label="Product name">
          <Input value={f.product_name} onChange={(e) => setF({ ...f, product_name: e.target.value })} />
        </Field>
        <div className="flex gap-2">{PRESETS.map((p) => <Button key={p} size="sm" variant={f.product_name === p ? "primary" : "secondary"} onClick={() => setF({ ...f, product_name: p })}>{p}</Button>)}</div>
        <Field label="Tagline"><Input value={f.tagline} onChange={(e) => setF({ ...f, tagline: e.target.value })} /></Field>
        <div className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-end">
          <Field label="Primary colour"><input type="color" value={f.primary_color} onChange={(e) => setF({ ...f, primary_color: e.target.value })} className="h-11 w-16 rounded-xl border border-slate-300" /></Field>
          <Field label="Hex"><Input value={f.primary_color} onChange={(e) => setF({ ...f, primary_color: e.target.value })} /></Field>
        </div>
        <p className="text-xs text-slate-500">Royal Blue #3158C9 is the approved primary. Avoid teal/turquoise.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Logo (optional)"><input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0], "logo_url")} className="text-sm" /></Field>
          <Field label="App icon (square PNG, optional)"><input type="file" accept="image/png" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0], "icon_url")} className="text-sm" /></Field>
          <Field label="Support email"><Input value={f.support_email} onChange={(e) => setF({ ...f, support_email: e.target.value })} /></Field>
          <Field label="Support phone"><Input value={f.support_phone} onChange={(e) => setF({ ...f, support_phone: e.target.value })} /></Field>
        </div>
        {(f.logo_url || f.icon_url) && <Button size="sm" variant="ghost" onClick={() => setF({ ...f, logo_url: "", icon_url: "" })}>Remove logo & icon</Button>}
      </Card>
      <Button size="lg" block loading={busy} onClick={save}>Publish branding</Button>
    </div>
  );
}
