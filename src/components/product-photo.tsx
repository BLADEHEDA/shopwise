"use client";
import { useRef, useState } from "react";
import {
  Battery, BatteryCharging, Cable, Camera, Cpu, Fan, Gamepad2, HardDrive, Headphones, Keyboard, Laptop, Lightbulb, LoaderCircle, MemoryStick, Mic, Monitor, Mouse, Package, PlugZap, Printer, Puzzle, Router, Smartphone, Speaker, Tv, Watch,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { cx, errorMessage, uuid } from "@/lib/format";
import type { Product } from "@/lib/types";
import { useToast } from "./toast";
import { useBiz } from "./biz";

type P = Pick<Product, "name" | "image_url"> & { categories?: { name: string } | null };

/** Picks a placeholder icon from the product's category and name, so a
 *  product without a photo is still easy to recognise in lists and the POS. */
function iconFor(p: P) {
  const t = `${p.categories?.name || ""} ${p.name}`.toLowerCase();
  if (/print/.test(t)) return Printer;
  if (/usb key|flash|memory card|sd card/.test(t)) return MemoryStick;
  if (/hard disk|hdd|ssd/.test(t)) return HardDrive;
  if (/mouse/.test(t)) return Mouse;
  if (/keyboard/.test(t)) return Keyboard;
  if (/microphone|\bmic\b/.test(t)) return Mic;
  if (/modem|router|wifi|flybox|ethernet|switch/.test(t)) return Router;
  if (/remote|tv stand|\btv\b/.test(t)) return Tv;
  if (/controller|gamepad|ps[2-5]/.test(t)) return Gamepad2;
  if (/bulb|light|lamp|torch/.test(t)) return Lightbulb;
  if (/\bfan\b/.test(t)) return Fan;
  if (/batter/.test(t) && !/power ?bank/.test(t)) return Battery;
  if (/hdmi|vga|display|monitor/.test(t)) return Monitor;
  if (/power ?bank|battery/.test(t)) return BatteryCharging;
  if (/charg|adapter|plug|station/.test(t)) return PlugZap;
  if (/cable|cord|wire|aux|usb|ethernet|type ?c/.test(t)) return Cable;
  if (/headset|headphone|earbud|earphone|pods|audio/.test(t)) return Headphones;
  if (/speaker/.test(t)) return Speaker;
  if (/watch/.test(t)) return Watch;
  if (/laptop|computer/.test(t)) return Laptop;
  if (/phone|iphone|android/.test(t)) return Smartphone;
  if (/cube|puzzle|toy|game|chess|jenga|klotski/.test(t)) return Puzzle;
  if (/arduino|board|chip|sensor|module|component/.test(t)) return Cpu;
  return Package;
}

export function ProductThumb({ product, className, iconClass = "size-6" }: { product: P; className?: string; iconClass?: string }) {
  if (product.image_url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={product.image_url} alt="" loading="lazy" className={cx("size-full object-cover", className)} />;
  }
  const Icon = iconFor(product);
  return (
    <div className={cx("grid size-full place-items-center bg-brand-50 text-brand-300", className)} aria-label="No photo yet">
      <Icon className={iconClass} strokeWidth={1.5} />
    </div>
  );
}

/** Upload a product photo straight from the phone camera. Managers can set or
 *  replace any photo in their sections; shopkeepers can only add a photo to a
 *  product that has none (enforced in the database). */
export function PhotoButton({ product, onDone, label }: { product: Pick<Product, "id" | "business_id" | "section_id" | "image_url">; onDone: (url: string) => void; label?: string }) {
  const biz = useBiz();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const allowed = biz.canManage(product.section_id) || (biz.role === "staff" && biz.hasSection(product.section_id) && !product.image_url);
  if (!allowed) return null;

  async function onFile(file: File) {
    if (!file.type.startsWith("image/")) { toast("Choose a photo", "error"); return; }
    setBusy(true);
    try {
      const blob = await shrinkImage(file);
      const path = `${product.business_id}/products/${uuid()}.jpg`;
      const up = await supabase().storage.from("shopwise").upload(path, blob, { contentType: "image/jpeg" });
      if (up.error) throw up.error;
      const url = supabase().storage.from("shopwise").getPublicUrl(path).data.publicUrl;
      const { error } = await supabase().rpc("set_product_image", { p_product: product.id, p_url: url });
      if (error) throw error;
      onDone(url);
      toast("Photo saved");
    } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); if (input.current) input.current.value = ""; }
  }

  return (
    <>
      <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); input.current?.click(); }} disabled={busy}
        className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-2.5 text-sm font-medium text-slate-700 hover:border-brand hover:text-brand disabled:opacity-50"
        aria-label={`${product.image_url ? "Change" : "Add"} photo`}>
        {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Camera className="size-4" />}
        {label ?? (product.image_url ? "Change" : "Photo")}
      </button>
      <input ref={input} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1}
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
    </>
  );
}

/** Resize to max 1000px and JPEG-compress: phone photos are 3–8 MB, this
 *  makes them ~100–200 KB so the POS stays fast on mobile data. */
export async function shrinkImage(file: File, max = 1000): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Could not process photo"))), "image/jpeg", 0.82));
  } catch {
    return file;
  }
}
