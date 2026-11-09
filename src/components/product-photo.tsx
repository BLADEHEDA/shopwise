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

type Up = Pick<Product, "id" | "business_id" | "section_id" | "image_url">;

/** Who may set a photo: managers can set or replace any photo in their
 *  sections; shopkeepers can only add one where there is none (also enforced
 *  in the database by set_product_image). */
function usePhotoUpload(product: Up, onDone: (url: string) => void) {
  const biz = useBiz();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const allowed = biz.canManage(product.section_id) || (biz.role === "staff" && biz.hasSection(product.section_id) && !product.image_url);

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
      toast(product.image_url ? "Photo changed" : "Photo saved");
    } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); if (input.current) input.current.value = ""; }
  }
  const open = (e?: React.MouseEvent) => { e?.preventDefault(); e?.stopPropagation(); input.current?.click(); };
  // no `capture`: phones then offer both camera and gallery
  const field = <input ref={input} type="file" accept="image/*" className="sr-only" tabIndex={-1} onClick={(e) => e.stopPropagation()}
    onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />;
  return { allowed, busy, open, field };
}

/** A button that adds or changes a product photo. */
export function PhotoButton({ product, onDone, label }: { product: Up; onDone: (url: string) => void; label?: string }) {
  const u = usePhotoUpload(product, onDone);
  if (!u.allowed) return null;
  return (
    <>
      <button type="button" onClick={u.open} disabled={u.busy}
        className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-2.5 text-sm font-medium text-slate-700 hover:border-brand hover:text-brand disabled:opacity-50"
        aria-label={`${product.image_url ? "Change" : "Add"} photo`}>
        {u.busy ? <LoaderCircle className="size-4 animate-spin" /> : <Camera className="size-4" />}
        {label ?? (product.image_url ? "Change photo" : "Add photo")}
      </button>
      {u.field}
    </>
  );
}

/** The product picture itself, editable in place: on a computer hovering shows
 *  "Change", on a phone a small camera badge sits on the corner; tap to pick a
 *  new photo. People who can't edit just see the picture. */
export function EditablePhoto({ product, onDone, className, iconClass = "size-5" }: { product: Up & P; onDone: (url: string) => void; className?: string; iconClass?: string }) {
  const u = usePhotoUpload(product, onDone);
  const box = cx("relative shrink-0 overflow-hidden rounded-lg", className);
  if (!u.allowed) return <div className={box}><ProductThumb product={product} iconClass={iconClass} /></div>;
  return (
    <>
      <button type="button" onClick={u.open} disabled={u.busy} className={cx("group", box)}
        aria-label={`${product.image_url ? "Change" : "Add"} photo of ${product.name}`} title={product.image_url ? "Change photo" : "Add photo"}>
        <ProductThumb product={product} iconClass={iconClass} />
        <span className="absolute inset-0 hidden flex-col place-items-center content-center justify-center gap-0.5 bg-ink/55 text-[10px] font-semibold text-white [@media(hover:hover)]:group-hover:flex">
          <Camera className="mx-auto size-4" />{product.image_url ? "Change" : "Add"}
        </span>
        <span className="absolute bottom-0.5 right-0.5 grid size-[18px] place-items-center rounded-full bg-white text-brand shadow ring-1 ring-slate-200 [@media(hover:hover)]:hidden">
          <Camera className="size-2.5" />
        </span>
        {u.busy && <span className="absolute inset-0 grid place-items-center bg-white/70"><LoaderCircle className="size-4 animate-spin text-brand" /></span>}
      </button>
      {u.field}
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
