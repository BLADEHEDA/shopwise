"use client";
import { createContext, useContext, useEffect, useState } from "react";
import type { Brand } from "./types";
import { supabase } from "./supabase";
import { DEFAULT_BRAND } from "./brand-defaults";

export { DEFAULT_BRAND };

const BrandCtx = createContext<{ brand: Brand; reload: () => void }>({ brand: DEFAULT_BRAND, reload: () => {} });

function readCache(): Brand {
  if (typeof window === "undefined") return DEFAULT_BRAND;
  try {
    const raw = localStorage.getItem("sw-brand");
    return raw ? { ...DEFAULT_BRAND, ...JSON.parse(raw) } : DEFAULT_BRAND;
  } catch { return DEFAULT_BRAND; }
}

export function BrandProvider({ children }: { children: React.ReactNode }) {
  const [brand, setBrand] = useState<Brand>(DEFAULT_BRAND);
  const [tick, setTick] = useState(0);

  useEffect(() => { setBrand(readCache()); }, []);

  useEffect(() => {
    let alive = true;
    supabase().from("brand_config").select("*").eq("id", 1).maybeSingle().then(({ data }) => {
      if (!alive || !data) return;
      const b = { ...DEFAULT_BRAND, ...data } as Brand;
      setBrand(b);
      try { localStorage.setItem("sw-brand", JSON.stringify(b)); } catch {}
    });
    return () => { alive = false; };
  }, [tick]);

  useEffect(() => {
    document.documentElement.style.setProperty("--brand", brand.primary_color || DEFAULT_BRAND.primary_color);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", brand.primary_color);
  }, [brand.primary_color]);

  return <BrandCtx.Provider value={{ brand, reload: () => setTick((t) => t + 1) }}>{children}</BrandCtx.Provider>;
}

export function useBrand() { return useContext(BrandCtx); }

export function BrandMark({ size = 36, className = "" }: { size?: number; className?: string }) {
  const { brand } = useBrand();
  if (brand.logo_url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={brand.logo_url} alt={brand.product_name} style={{ height: size }} className={className} />;
  }
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span
        className="grid place-items-center rounded-xl bg-brand text-white font-bold"
        style={{ width: size, height: size, fontSize: size * 0.5 }}
        aria-hidden
      >
        {brand.product_name.charAt(0).toUpperCase()}
      </span>
      <span className="font-semibold tracking-tight text-ink" style={{ fontSize: size * 0.5 }}>{brand.product_name}</span>
    </span>
  );
}
