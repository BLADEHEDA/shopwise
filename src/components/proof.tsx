"use client";
import { useRef, useState } from "react";
import { Eye, ImagePlus, LoaderCircle, Paperclip, X } from "lucide-react";
import { shrinkImage } from "@/components/product-photo";
import { useToast } from "@/components/toast";
import { supabase } from "@/lib/supabase";
import { cx, errorMessage, uuid } from "@/lib/format";

/** Proof of payment: the screenshot customers send after paying by
 *  MoMo / Orange Money / bank / crypto. Stored privately (only people in the
 *  business can open it, through a link that expires). */
export function ProofButton({ businessId, value, onChange, disabled, compact }: {
  businessId: string; value: string | null | undefined; onChange: (path: string | null) => void; disabled?: boolean; compact?: boolean;
}) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    if (!file.type.startsWith("image/")) { toast("Choose a screenshot or photo", "error"); return; }
    setBusy(true);
    try {
      const blob = await shrinkImage(file, 1400);
      const path = `${businessId}/${uuid()}.jpg`;
      const { error } = await supabase().storage.from("proofs").upload(path, blob, { contentType: "image/jpeg" });
      if (error) throw error;
      onChange(path);
    } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); if (input.current) input.current.value = ""; }
  }

  if (value) {
    return (
      <span className="inline-flex h-11 items-center gap-1 rounded-xl border border-emerald-300 bg-emerald-50 pl-3 pr-1 text-sm font-semibold text-emerald-800">
        <Paperclip className="size-4" /> Proof attached
        <button type="button" onClick={() => viewProof(value)} className="grid size-8 place-items-center rounded-lg hover:bg-emerald-100" aria-label="View proof"><Eye className="size-4" /></button>
        <button type="button" onClick={() => onChange(null)} className="grid size-8 place-items-center rounded-lg hover:bg-emerald-100" aria-label="Remove proof"><X className="size-4" /></button>
      </span>
    );
  }
  return (
    <>
      <button type="button" onClick={() => input.current?.click()} disabled={disabled || busy} title={disabled ? "Needs internet" : undefined}
        className={cx("inline-flex h-11 items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-400 bg-white px-3 text-sm font-semibold text-slate-700 hover:border-brand hover:text-brand disabled:opacity-50", compact && "px-2.5")}>
        {busy ? <LoaderCircle className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
        {disabled ? "Proof (needs internet)" : "Upload proof screenshot"}
      </button>
      <input ref={input} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-label="Proof of payment screenshot"
        onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
    </>
  );
}

export async function viewProof(path: string) {
  const w = window.open("", "_blank");
  const { data, error } = await supabase().storage.from("proofs").createSignedUrl(path, 600);
  if (error || !data) { w?.close(); return; }
  if (w) w.location.href = data.signedUrl; else window.location.href = data.signedUrl;
}
